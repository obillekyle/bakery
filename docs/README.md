# Bakery

A full-stack framework for [Bun](https://bun.sh) where the filesystem is the
routing table: drop a `.tsx`, `.html`, `.ts` or `/api` file under `src/` and it
is a live route on the next request. There is no build step in development, no
route manifest to register, and no bundler config to maintain.

## Prerequisites

| | |
| --- | --- |
| **Runtime** | Bun **1.3.14 or newer**. Not optional — `Bun.serve` is the server, `Bun.SQL` the database driver, `Bun.build` the compiler. There is no Node fallback. |
| **Package manager** | Bun. `npm install` resolves the packages but cannot run them. |
| **TypeScript** | Only for typechecking and editor support. Bun transpiles at runtime; a generated app installs `typescript` and `bun-types` for you. |

## Quickstart

```bash
bun create bakery my-app
```

```bash
cd my-app && bun run dev
```

Open [localhost:3000](http://localhost:3000). That is the whole loop — the scaffolder writes a
working app, installs its dependencies, and `bun run dev` serves it with live
reload.

### Hello world, from nothing

If you would rather see the smallest thing that runs, two files are enough:

```bash
bun add @bakery-framework/core @bakery-framework/cli
```

`package.json`:

```json
{
  "name": "storefront",
  "type": "module",
  "scripts": { "dev": "bakery --dev" }
}
```

`src/api/hello.ts`:

```ts
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute<{ name?: string }>((req, body) => {
  if (!body.name) return response.json.error(400, 'name is required')
  return response.json.success('ok', { greeting: `Hello, ${body.name}` })
})
```

```bash
bun run dev
```

```bash
curl 'http://localhost:3000/api/hello?name=Ada'
```

```json
{ "time": 1.1, "status": 200, "message": "ok", "data": { "greeting": "Hello, Ada" } }
```

No `server.config.ts`, no `tsconfig.json`, no server object to construct. The
file's path *is* the route.

> **Adding a `.tsx` page needs one more file.** Pages render through Bakery's own
> `createElement`, and Bun's runtime does not follow `extends` into a package
> specifier — so a `tsconfig.json` repeating three `jsx*` options is required, or
> every page returns 500 while `tsc` stays clean. `bun create bakery` writes it
> correctly; [Installation](getting-started/installation.md#adding-bakery-to-an-existing-project)
> has the file.

## Key concepts

- **Filesystem routing.** A URL resolves against the serve root *per request*,
  so a dropped-in file serves and a deleted one stops — no restart, no manifest.
  Resolution is exact file → directory index → `[param]` segment, and static
  always beats dynamic.
- **Handlers.** Every request surface is a `Handler` subclass registered with a
  priority: `/api` at 70, `.tsx` at 60, `.html` at 55, static files at 0. The
  first handler whose `canHandle` claims the path wins.
- **Three registries, three scales.** `fetch`, `error` and `websocket` are
  independent — a fetch handler at 90 and an error handler at 20 are not
  comparable.
- **Middleware.** An array in `server.config.ts`, running before routing. Return
  a `Response` or a `response.json.*` envelope to stop the request; return
  nothing to continue.
- **Ambient config.** `Bakery.config` is a getter that answers for the host being
  served right now, so per-hostname configuration needs no threading through call
  arguments. See [the `Bakery` object](reference/bakery.md).
- **Sessions.** A lazily-created cookie session on every request, backed by
  memory then SQLite. Nothing is written until you write to it.
- **State.** There is no framework-owned store. Request state is the request;
  durable state is the optional ORM, or whatever you bring.

## Common patterns

### Routing and path params

| File | Serves |
| --- | --- |
| `src/index.tsx` | `/` |
| `src/pricing.html` | `/pricing` |
| `src/api/orders.ts` | `/api/orders` |
| `src/api/orders/[id].ts` | `/api/orders/42` |
| `src/checkout.ts` | `/checkout.js` — compiled for the browser |

Dynamic segments arrive merged into the body object, not as a separate argument:

```ts
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute<{ id: string }>((req, body) =>
  response.json.success('ok', { orderId: body.id, method: req.method }),
)
```

### Request and response

The second argument is the **parsed** body: the query string for `GET` and
`HEAD`, otherwise JSON, form data, or `{ file }` for a binary content type.

Every JSON body the server emits uses one envelope — `{time, status, message,
data}`:

| Call | Result |
| --- | --- |
| `response.json.success(message, data?)` | 200 with `data` |
| `response.json.error(status, message, data?)` | that status, same envelope |
| `response.text(body)` | `text/plain` |
| `response.html(markup)` | `text/html` |
| `response.href(url, 302)` | a redirect |

A page returns markup instead:

```tsx
import { HTMLBody } from '@bakery-framework/core'

export default HTMLBody(() => (
  <html lang="en">
    <head>
      <title>Orders</title>
    </head>
    <body>
      <h1>Orders</h1>
    </body>
  </html>
))
```

### Middleware

```ts
import { defineConfig, response } from '@bakery-framework/core'

export default defineConfig({
  middleware: [
    req => {
      const { pathname } = new URL(req.url)
      if (pathname.startsWith('/admin') && !req.session.get('userId')) {
        return response.json.error(401, 'Sign in required')
      }
    },
  ],
})
```

A `Response` or a `response.json.*` envelope stops the chain; returning nothing
continues. Anything else — a string, a bare object, `true` — is ignored and the
next middleware runs. A **throw** is a 500 and stops the request — deliberately,
because middleware is where auth checks live, and treating a crashed check as "no
opinion" would let the request through.

> The envelope reaches the client verbatim. A plain `Response` with a 4xx/5xx
> status keeps its status but has its **body replaced** by the error page, since
> anything at or above 400 is routed through the error pipeline.
> [Middleware](guides/middleware.md) has the details.

## Error handling

**Return the error, do not throw it.** Guards return `Response | null`, the
caller returns it if present, and an expected denial never becomes an exception:

```ts
import { defineRoute, response } from '@bakery-framework/core'

// Returns the rejection, or null when the request may proceed. Leave the return
// type to inference: `response.json.*` produces a JsonResponseData that the
// router serialises, not a `Response`, so annotating it `Response | null` does
// not compile.
function requireAdmin(req: Request) {
  return req.session.get('role') === 'admin'
    ? null
    : response.json.error(403, 'Admins only')
}

export default defineRoute(req => {
  const denied = requireAdmin(req)
  if (denied) return denied

  return response.json.success('ok')
})
```

Fail closed: return the rejection on any *indeterminate* state too, not only a
confirmed denial. An analytics endpoint here once returned `null` when it could
not tell, which is a fail-open bug wearing a guard's clothing.

**Validate at the boundary.** A type parameter states a contract; it does not
enforce one. Pass a validator and the handler only runs on a body that satisfies
it:

```ts no-check — `orderSchema` stands in for a Standard Schema the reader supplies
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute({ body: orderSchema }, async (req, order) => {
  // `order` is the parsed value; a rejection answered 400 before you got here.
  return response.json.success('created', order)
})
```

`body` accepts any [Standard Schema](https://standardschema.dev) — zod, valibot,
arktype — or a plain function that returns the parsed value or throws. Bakery
bundles none of them.

**Error pages are files.** `error-404.html`, `error.tsx`, `error-500.tsx` — the
name encodes the scope, and lookup walks *up* from the requested path, trying
`error-<code>` before `error` at each level:

```
src/orders/error-404 → src/orders/error → src/error-404 → src/error
```

Errors under `/api/` never reach any of this; they answer with the JSON envelope
and the right status.

### Best practices

| Do | Instead of |
| --- | --- |
| Return `response.json.error(...)` from a route | Throwing for an expected denial |
| `defineRoute({ body: schema }, handler)` | Trusting `defineRoute<T>` to validate |
| `middleware` for auth — only two return shapes halt it | The `onRequest` hook, where any truthy return halts the request |
| `Bakery.dataDir` for anything precious | `.cache/`, which the framework deletes on its own |
| `hostKey(path)` for a per-tenant cache | Keying a map on a client-supplied header |

## Where to go next

| | |
| --- | --- |
| [Installation](getting-started/installation.md) | Flags, existing projects, working on the framework |
| [Your first app](getting-started/first-app.md) | Every file, explained |
| [Project structure](getting-started/project-structure.md) | What each directory means |
| [Routing](guides/routing.md) · [API routes](guides/api-routes.md) · [Middleware](guides/middleware.md) | The request surface in full |
| [Sessions](guides/sessions.md) · [WebSockets](guides/websockets.md) · [Server-sent events](guides/server-sent-events.md) · [CORS](guides/cors.md) | Everything else core serves |
| [Schema](orm/schema.md) · [Queries](orm/queries.md) · [Mutations](orm/mutations.md) · [Schema sync](orm/sync.md) · [Adapters](orm/adapters.md) | The optional ORM |
| [Plugin API](plugins/plugin-api.md) · [Vue](plugins/vue.md) · [Analytics](plugins/analytics.md) · [Dashboard](plugins/dashboard.md) · [Database Explorer](plugins/db-explorer.md) | Plugins, and writing your own |
| [Production](deployment/production.md) · [Security](deployment/security.md) | Shipping it |
| [Architecture](reference/architecture.md) · [The `Bakery` object](reference/bakery.md) · [CLI](reference/cli.md) · [Troubleshooting](reference/troubleshooting.md) | Reference |

Every TypeScript example in this tree is compiled against the real packages by
`tests/docs-examples.test.ts`, so a snippet that stops working fails the build
rather than the reader.
</content>
