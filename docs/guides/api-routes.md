# API routes

An API route is a `.ts` or `.js` file under **`src/api/`** whose default export
is called with the parsed request. `ApiHandler` claims every path starting with
`/api/` at priority 70 (`packages/core/src/startup.ts`).

## Where the files live

`Bakery.apiRoot` is `<serveRoot>/api` (`packages/core/src/core/bakery.ts`),
and `serveRoot` is `config.root`, default `src`. So with a default config:

```
src/api/hello.ts          →  /api/hello
src/api/users/index.ts    →  /api/users
src/api/users/[id].ts     →  /api/users/42
```

There is no root-level `api/` directory. If you put one there it will never be
found — it is outside the serve root, and the containment check in
`handleRequest` refuses to look.

The prefix test is `path.startsWith('/api/')` (`handlers/routes/api.ts`), with
the trailing slash. `/api` on its own does not match and falls through to the
page handlers.

## The signature

The typed contract lives in `@bakery/core` (`packages/core/src/types.d.ts`):

```ts no-check — a type signature, not runnable code
type RouteHandler<P = {}> = (
  req: Request,
  body: RouteBody<P>, // P & MapOf<any> — declared params over a permissive base
  server?: Bun.Server<any>,
) => RouteResponse
```

**The parsed body is the second parameter.** `req.body` is a `ReadableStream` —
the raw web-standard property — and reading `req.body.user` gets you `undefined`,
not your JSON.

`defineRoute` is an identity function whose only job is inference: declare the
body shape once as the type argument and the whole signature follows, instead of
annotating `(req: Request, body: any)` by hand.

```ts
import { defineRoute, response } from '@bakery/core'

export default defineRoute<{ title?: string }>(async (req, body) => {
  if (req.method !== 'POST') {
    return response.json.error(405, 'Method Not Allowed')
  }

  const title = String(body.title ?? '').trim()
  if (!title) return response.json.error(400, 'title is required')

  return response.json.success('created', { title })
})
```

`body.title` is `string | undefined` inside the handler; keys you did not
declare stay reachable as `any`, because the parse rules below mean the
framework cannot enumerate every key. Declaring a shape states your contract —
it does not validate the request, so validate anyway. There is no
filename-based inference: `[id].ts` does not conjure `{ id: string }` on its
own.

The older ambient `ApiCallback` type still exists and still describes the same
calling convention, untyped.

The third parameter is `Bakery.server`, passed by the module's only call site
(`packages/core/src/handlers/core/$dynamic.ts`). `RouteHandler` declares it
optional because `Bakery.server` is itself unset until `Bun.serve` has started —
if you need the server, `Bakery.server` is always the safer reach.

## What `body` actually contains

`Handler.params` merges the parsed body with the route params, params last
(`$base.ts`). The parse itself depends on the method and the content type
(`packages/core/src/utils/http/body.ts`):

| Request | `body` is |
| --- | --- |
| `GET` / `HEAD` | the query string, as a flat object |
| `Content-Type: application/json` | the parsed JSON |
| `application/x-www-form-urlencoded` or `multipart/form-data` | the form fields; repeated names collect into an array |
| `application/*`, `image/*`, `audio/*`, `video/*`, `model/*` | `{ file: Blob }` |
| anything else | `{ data: string }` |

A parse failure is swallowed and yields `{}` (`body.ts`) — a malformed JSON
POST reaches your handler with an empty body rather than a 400. Validate.

For a dynamic route, the bracket segments are merged in afterwards and win over
anything of the same name in the body:

```ts
import { defineRoute, response } from '@bakery/core'

// src/api/users/[id].ts  →  /api/users/42
export default defineRoute<{ id: string }>(async (_req, body) => {
  return response.json.success('ok', { id: body.id }) // body.id: string
})
```

A bracket param is always a string when the route matches, so `{ id: string }`
(non-optional) is the honest declaration here — unlike body fields, which the
client controls.

## CSRF: why your POST returns 403

`ApiHandler.handle` runs a same-origin check *before* resolving the route
(`handlers/routes/api.ts`). If it fails, the request never reaches your
file and you get a 403 with the JSON envelope:

```json
{ "time": 0, "status": 403, "message": "cross-site request rejected (Sec-Fetch-Site: cross-site)" }
```

The rule (`packages/core/src/utils/http/csrf.ts`):

- `GET`, `HEAD` and `OPTIONS` always pass.
- Any other method is rejected if `Sec-Fetch-Site` is present and is not one of
  `same-origin`, `same-site`, `none`.
- Any other method is rejected if `Origin` is present, is not the literal string
  `null`, and does not equal the request's own origin.
- A request carrying **neither** header passes. Browsers always send at least one
  on a cross-origin request; curl and server-to-server callers send neither, and
  blocking them would break every non-browser client.

This exists because `SameSite=Lax` is not enough on its own: a cross-site form
POST is a CORS-simple request, so the victim's session cookie rides along with
it.

Things that trip it in practice:

- Calling your API from a different port during development —
  `http://localhost:5173` posting to `http://localhost:3000` is cross-origin, and
  the `Origin` header will not match.
- Posting from a page served on a different hostname in a multi-host setup.
- A `fetch` with `mode: 'no-cors'` from another origin.

There is no configuration switch to disable it. If a third party genuinely needs
to POST to you, give them an endpoint that does not rely on cookie auth and
expect to write the CORS handling yourself in middleware.

Note the check is not applied to page routes, only to `/api/`.

## Responses

Return anything `processResponse` understands (`packages/core/src/router.ts`):
a `Response`, a `BunFile`, a string, a plain object, or — preferably — one of the
`response.json.*` helpers.

Every JSON body the server emits uses one envelope:

```json
{ "time": 1, "status": 200, "message": "created", "data": { "title": "hi" } }
```

`time` is filled in with the elapsed request time at serialisation. The helpers
(`packages/core/src/utils/http/response.ts`):

```ts
import { response } from '@bakery/core'

export default function handler() {
  response.json(200, 'ok', { a: 1 })       // status, message, data
  response.json.success('ok', { a: 1 })    // status defaults to 200
  response.json.error(404, 'not found')    // status, message, data
  return response.json.success('done')
}
```

`response.json.error` clamps a nonsensical status to 400 and accepts a
string-first form (`response.json.error('bad input')` → 400). A plain object
returned from a handler is `JSON.stringify`d as-is, without the envelope — use
the helpers unless you specifically want a bare payload.

Returning `undefined` or `null` produces a **404**, not a 204: `ApiHandler.handle`
substitutes `response.error('No response from handler')`
(`handlers/routes/api.ts`), which defaults to status 404. The 204 that
`processResponse` produces for an empty result never applies here. A module with
no default export is likewise a 404. If you want an empty success, say so:

```ts
import { response } from '@bakery/core'

export default function handler() {
  return new Response(null, { status: 204 })
}
```

A request to a path under `/api/` with no matching file is also a 404 — but from
`response.error('No API handler found')` (`api.ts`), because
`ApiHandler.canHandle` only tests the prefix and never checks that the route
exists.

## Errors

A throw inside your handler is not caught by the framework's import guard — it
propagates to the worker, which routes it through `handleRequestError`
(`packages/cli/src/worker.ts`). For an `/api/` path the `error` registry's
top entry is `ApiErrorHandler` (priority 30), which answers with the envelope:

```json
{ "time": 3, "status": 500, "message": "..." }
```

So an unhandled exception in an API route returns JSON, not the HTML error page.
To control the status, throw a `HandlerError`:

```ts
import { HandlerError } from '@bakery/core/handlers'

export default function handler(req: Request) {
  throw new HandlerError('Not your record', req, {
    errorCode: 403,
    errorText: 'Forbidden',
    errorBody: 'record belongs to another user',
  })
}
```

A **syntax or import error** in the route file is treated differently: it is
caught, logged as `API_IMPORT_ERR`, and the request becomes a 404
(`$dynamic.ts`). Check the server log before assuming a route is missing.

## Module reloading

`ApiHandler.executeModule` appends `?v=<mtime>` to the import specifier
(`handlers/routes/api.ts`) so that saving a file invalidates the ES module
cache. In development, editing anything under `api/**` additionally restarts the
dev worker (`compiler/dev-service.ts`).

Because each distinct mtime is a distinct module identity, module-level state in
an API route does not survive an edit. Do not keep a connection pool or a cache
in a module-level `const` there.

## Non-function exports

If the default export is not a function it is returned directly
(`$dynamic.ts`). This is occasionally useful for a fixed payload:

```ts
export default { version: 1, features: ['a', 'b'] }
```

## Reserved namespace

`/api/_*` is reserved for the framework and its plugins — `/api/_dashboard/*` is
in use today. Plugin endpoint tables go through `routeTable()`
(`packages/core/src/plugins/routes.ts`), not through this directory.
