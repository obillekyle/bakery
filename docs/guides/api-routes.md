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
src/api/[...path].ts      →  /api/<anything deeper nothing else claims>
```

A terminal `[...name]` segment is a catch-all: it matches one or more remaining
segments and binds them as an array (`path = ["users", "42", "posts"]`). The
`[...name!]` spelling also claims its bare directory, binding `[]` there. Every
more specific route — exact files, `[param]` siblings, child indexes, deeper
catch-alls — wins first; see the routing guide for the precedence ladder.

There is no root-level `api/` directory. If you put one there it will never be
found — it is outside the serve root, and the containment check in
`handleRequest` refuses to look.

The prefix test is `path.startsWith('/api/')` (`handlers/routes/api.ts`), with
the trailing slash. `/api` on its own does not match and falls through to the
page handlers.

## The signature

The typed contract lives in `@bakery-framework/core` (`packages/core/src/types.d.ts`):

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
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute<{ title?: string }>(async (req, body) => {
  if (req.method !== 'POST') {
    return response.json.error(405, 'Method Not Allowed')
  }

  const title = String(body.title ?? '').trim()
  if (!title) return response.json.error(400, 'title is required')

  return response.json.success('created', { title })
})
```

Route params land in the same `body`, so a dynamic route declares them the
same way — one type argument stating what the file name promises. For
`src/api/[region]/[warehouse]/[...rest].ts`:

```ts
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute<{
  region: string
  warehouse: string
  rest: string[] // a catch-all binds its segments, [] under [...rest!]
}>(async (_req, body) => {
  return response.json.success('located', {
    region: body.region,
    bin: body.rest.join('/'),
  })
})
```

There is no filename inference — `[region].ts` does not conjure
`{ region: string }` on its own — the contract is that you declare what you
expect, once, and the compiler holds you to it everywhere in the handler. A
route over mixed or unknown segments can write `defineRoute<MapOf<RouteParam>>`
instead of hand-writing `string | string[]`.

`body.title` is `string | undefined` inside the handler; keys you did not
declare stay reachable as `any`, because the parse rules below mean the
framework cannot enumerate every key. Declaring a shape states your contract —
it does not validate the request, so validate anyway, either by hand or with the
two-argument form below. There is no filename-based inference: `[id].ts` does not
conjure `{ id: string }` on its own.

## Validating the body

Pass a validator and the handler only runs on a body that satisfies it:

```ts no-check — `mySchema` stands in for a Standard Schema the reader supplies
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute({ body: mySchema }, async (req, body) => {
  // `body` is the *parsed* value — whatever the schema produced, not the raw
  // input — and a rejection answered 400 before you got here.
  return response.json.success('ok', body)
})
```

`body` accepts either shape:

- **A [Standard Schema](https://standardschema.dev)** — the common interface zod,
  valibot and arktype all implement. Bakery bundles none of them and depends on
  none of them; it reads the `~standard` property they each expose, so any
  library implementing that spec works without an adapter.
- **A plain function** returning the parsed value, or throwing. Enough for one
  field, and it keeps a dependency out of an app that does not want one.

```ts
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute(
  {
    body: (input: any) => {
      const title = String(input?.title ?? '').trim()
      if (!title) throw new Error('title is required')
      return { title }
    },
  },
  async (req, body) => response.json.success('created', body),
)
```

A rejection answers **400** through the same JSON envelope as everything else,
with the issues in `data`:

```json
{
  "time": 0.4,
  "status": 400,
  "message": "Invalid request body",
  "data": { "issues": [{ "path": "title", "message": "Required" }] }
}
```

Nested paths render as `user.address.city`, and array indices as `items.0.id`.

**The one-argument form is unchanged**, and the two forms cannot be confused:
`defineRoute(fn)` types the body, `defineRoute({ body }, fn)` validates it. Both
are identity functions at runtime — the second returns a wrapped handler, the
first returns yours untouched.

Validation runs on the already-parsed body, so it sees the same merged object
the handler would have: query string for `GET`/`HEAD`, otherwise JSON or form
data, with dynamic route parameters merged in.

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
import { defineRoute, response } from '@bakery-framework/core'

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
to POST to you, give them an endpoint that does not rely on cookie auth — that
is what makes it safe to expose, and it is why the guard can stay unconditional.

**Configuring [`cors`](cors.md) does not turn this off, and is not meant to.**
The two answer different questions: CORS tells the browser whether it may *read*
a cross-origin response, and the CSRF guard decides whether an unsafe method
carrying the user's cookie is allowed to run at all.

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
import { response } from '@bakery-framework/core'

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

A handler that runs and returns nothing produces a **404**, not a 204:
`ApiHandler.handle` substitutes `response.error('No response from handler')`
(`handlers/routes/api.ts`), which defaults to status 404. The 204 that
`processResponse` produces for an empty result never applies here.

A module with **no default export** is a different fault and answers **500**,
naming the file: the route resolved and the file is on disk, so a 404 sent you
looking for something that was already there. The server log names it too. If
you want an empty success, say so:

```ts
import { response } from '@bakery-framework/core'

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
import { HandlerError } from '@bakery-framework/core/handlers'

export default function handler(req: Request) {
  throw new HandlerError('Not your record', req, {
    errorCode: 403,
    errorText: 'Forbidden',
    errorBody: 'record belongs to another user',
  })
}
```

A **syntax or import error** in the route file is a server fault, not a missing
route: it is logged as `API_IMPORT_ERR` with the file path and rethrown, so the
request becomes a **500** — with the failure detail shown in development and
redacted in production (`$dynamic.ts`). It used to be a 404, which sent the
developer hunting for a missing file instead of reading the error.

## Module reloading

In development, `ApiHandler.executeModule` appends `?v=<mtime>` to the import
specifier (`handlers/routes/api.ts`) so that saving a file invalidates the ES
module cache; editing anything under the configured api directory additionally
restarts the dev worker (`compiler/dev-service.ts`), which is what picks up
changes to a route's *imports*. In production the bare specifier is imported
once and served from the module registry — route files cannot change under a
process that runs no watcher, and the per-request stat would be pure waste.

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
