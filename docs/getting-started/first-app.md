# Your first app

We will build a small notes app: one server-rendered page, one JSON endpoint,
one table. It ends up as roughly sixty lines across eight files, and there is no
build step at any point.

The best reference for this is [`apps/starter`](../../apps/starter) — a second
consumer written against public entry points only, deliberately kept minimal.
What follows is the same shape with the parts explained.

Follow [Installation](installation.md) first. Everything below happens inside a
clone of the repo, because the packages are not published yet.

## 1. Create the app

Bun's workspace covers `apps/*`, so a new directory there becomes a linked
consumer of `@bakery-framework/core`, `@bakery-framework/orm` and `@bakery-framework/cli`.

```bash
mkdir -p apps/notes/src/api apps/notes/orm
```

`apps/notes/package.json`:

```json
{
  "name": "@bakery-framework/notes",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --smol run ../../packages/cli/src/index.ts --dev",
    "serve": "bun --smol run ../../packages/cli/src/index.ts",
    "db:sync": "bun --smol run ../../packages/orm/src/sync"
  },
  "dependencies": {
    "@bakery-framework/core": "workspace:*",
    "@bakery-framework/cli": "workspace:*",
    "@bakery-framework/orm": "workspace:*"
  }
}
```

`apps/notes/tsconfig.json`:

```json
{
  "extends": "@bakery-framework/core/tsconfig.app.json",
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "createElement",
    "jsxFragmentFactory": "Fragment"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "orm/**/*.ts", "server.config.ts"]
}
```

The three `jsx*` options are repeated here even though `extends` already sets
them, and dropping them breaks every page. See
[installation](installation.md#editor-and-typechecking-setup) for why.

Then re-run install from the repo root so the workspace links the new app:

```bash
bun install
```

## 2. Configure it

`apps/notes/server.config.ts`:

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  port: 3200,
})
```

`defineConfig` is an identity function — it exists purely so your editor
typechecks the object against `AppConfig`. The config file is optional; the
defaults (`root: 'src'`, `port: 3000`, `host: '0.0.0.0'`) are a working config
on their own ([packages/core/src/core/config.ts](../../packages/core/src/core/config.ts)).

`root` is the only option that matters right now. It is the directory the router
serves from, and everything else is derived from it — notably `apiRoot`, which
is always `<root>/api`
([packages/core/src/core/bakery.ts](../../packages/core/src/core/bakery.ts)).
With `root: 'src'`, API routes live at **`src/api/`**, not at a project-root
`api/`.

`port` is not a command-line flag. `PORT` in the environment overrides it.

## 3. Declare the schema

Two files. `orm/schema.ts` holds the tables; `orm/index.ts` re-exports them and
registers their types with the framework. That split exists because
`db:sync --choose=db` regenerates `schema.ts` from the database — anything
hand-written beside the tables would be collateral
([packages/orm/src/sync/load.ts](../../packages/orm/src/sync/load.ts)).

`apps/notes/orm/schema.ts`:

```ts
import { Field, table } from '@bakery-framework/orm'

export const notes = table('notes', {
  id: Field.Primary(),
  title: Field.Varchar(255, null),
  body: Field.Varchar(8192, ''),
  createdAt: Field.Date.now(),
})
```

Columns come from `Field`; typing `Field.` lists every kind. A `null` default
makes the column nullable and therefore optional on insert — `Field.Varchar(255)`
without one is NOT NULL, so you must supply it. `Field.Varchar` rather than
`Field.Text` wherever there is a default, because MySQL refuses a literal
DEFAULT on a TEXT column.

`apps/notes/orm/index.ts`:

```ts no-check — module augmentation plus a relative import of the reader's own schema.ts; neither resolves outside a real app
import type { InferOptionals, InferSchema, InferViews } from '@bakery-framework/orm'
import * as model from './schema'

export * from './schema'

declare module '@bakery-framework/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: InferSchema<typeof model>
      DBOptionals: InferOptionals<typeof model>
      Views: InferViews<typeof model>
    }
  }
}
```

That `declare module` block is how your tables become the ORM's types. It is
declaration merging, the same pattern TanStack Router and vue-router use, and it
exists so the framework never has to import an app-owned file
([packages/orm/src/schema-registry.ts](../../packages/orm/src/schema-registry.ts)).

**Skipping it is legal.** Without a registration every table and column falls
back to permissive `any`, and everything still runs and typechecks — the ORM is
just untyped. The *runtime* never reads the registry; schema values are loaded
by path.

> `schema.ts` is ignored by this repo's root `.gitignore` at any depth, so
> `apps/notes/orm/schema.ts` will not be committed. That is intended for an app
> whose schema the generator owns, and a trap if you did not expect it.

## 4. Create the database

```bash
cd apps/notes && bun run db:sync
```

This creates `bakery/server.db`, applies the schema, and prints what it did.
Nothing is configured — SQLite at `bakery/server.db` is the default when no
`DB_URL` is set.

You can preview instead of applying:

```bash
bun run db:sync --dry-run
```

Destructive plans (dropping a table or column, renaming, rebuilding, dropping an
index) prompt for confirmation in development and **refuse outright in
production** unless you pass `--force-sync`
([packages/orm/src/sync/engine.ts](../../packages/orm/src/sync/engine.ts)).
See [Schema sync](../orm/sync.md).

## 5. Add the API route

`apps/notes/src/api/notes.ts` — reachable at `/api/notes`, because the file is
`notes.ts` under `<root>/api`:

```ts
import { response } from '@bakery-framework/core'
import DB from '@bakery-framework/orm'

export default async function handler(req: Request, body: any) {
  if (req.method === 'POST') {
    if (!body.title) return response.json.error(400, 'title is required')
    await DB.Insert.into('notes')
      .values({ title: body.title, body: body.body ?? '' })
      .run()
    return response.json.success('created')
  }

  const notes = await DB.from('notes').selectAll('notes').array()
  return response.json.success('ok', notes)
}
```

Three things worth knowing:

**The second argument is the parsed body.** For `GET` and `HEAD` it is the query
string as an object; otherwise it is the parsed JSON, form data, or `{ file }`
for a binary content type
([packages/core/src/utils/http/body.ts](../../packages/core/src/utils/http/body.ts)).
Dynamic route parameters are merged into the same object. It is `any` — it comes
from the client, so validate it.

**Every JSON body uses one envelope**: `{time, status, message, data}`.
`response.json.success(message, data)` and `response.json.error(status, message)`
are the only two shapes you need. `time` is filled in by the router with the
request's elapsed milliseconds.

**Unsafe methods must be same-origin.** `ApiHandler` runs a CSRF guard before
resolving the route: `GET`/`HEAD`/`OPTIONS` pass, anything else is rejected with
403 if `Origin` disagrees with the request URL or `Sec-Fetch-Site` says
cross-site ([packages/core/src/handlers/routes/api.ts](../../packages/core/src/handlers/routes/api.ts)).
A request with *neither* header — curl, a server-to-server call — is allowed,
because browsers always send at least one. That is the intended trade-off, not
an oversight; it means the guard protects browser users without breaking API
clients.

## 6. Add the page

`apps/notes/src/index.tsx` — served at `/`, because `index` is the fallback
route name:

```tsx
import { HTMLBody } from '@bakery-framework/core'

export default HTMLBody(() => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Notes</title>
    </head>
    <body>
      <h1>Notes</h1>
      <ul id="list">
        <li>loading…</li>
      </ul>
      <script src="/script.js" type="module"></script>
    </body>
  </html>
))
```

Exporting the JSX directly — without `HTMLBody` — also works. `createElement`
returns a `SafeHtml`, a `String` *subclass* used so the renderer can tell
already-escaped markup from user text
([packages/core/src/core/jsx.ts](../../packages/core/src/core/jsx.ts)), and
this used to trip the handler's "is this an object?" JSON check
(`typeof new String('') === 'object'`), serving the page as
`{"status":200,…,"data":"<html>…"}`. The handler now unboxes `SafeHtml` back
to a primitive string before that check
([packages/core/src/handlers/assets/tsx.ts](../../packages/core/src/handlers/assets/tsx.ts)),
so an unwrapped page is served as HTML — `apps/starter/src/index.tsx` exports
unwrapped JSX and works.

`HTMLBody` is still worth using: it prepends the `<!DOCTYPE html>` (an
unwrapped page is served without one) and, if you return a fragment rather
than a full `<html>` document, wraps it in a minimal one
([packages/core/src/core/jsx.ts](../../packages/core/src/core/jsx.ts)).

## 7. Add the browser script

`apps/notes/src/script.ts`:

```ts
const res = await fetch('/api/notes')
const json = await res.json()
const list = document.getElementById('list')

if (list) {
  list.innerHTML = ''
  for (const note of json.data ?? []) {
    const li = document.createElement('li')
    li.textContent = note.title
    list.append(li)
  }
}
```

Note the mismatch between the filename and the URL: the file is `script.ts` and
the page requests `/script.js`. `TSHandler` strips a trailing `.js`, compiles
the TypeScript through `Bun.build`, and caches the output under
`.cache/ts_cache`
([packages/core/src/handlers/assets/ts.ts](../../packages/core/src/handlers/assets/ts.ts)).
Requesting `/script.ts` directly works too. There is no bundler config and no
output directory.

There is also a convention you get for free: if a page is `foo.tsx` and a
`foo.ts` or `foo.css` sits beside it, the corresponding `<script>` or `<link>`
tag is injected automatically
([packages/core/src/handlers/assets/tsx.ts](../../packages/core/src/handlers/assets/tsx.ts)).

## 8. Run it

```bash
cd apps/notes && bun run dev
```

```
[I] serve   Starting server in development mode...
[I] db-sync schema.ts is perfectly synced with Database!
[I] serve   Server running at:
[I] serve     ➜ Local  : http://localhost:3200
```

Development mode checks the schema before every boot, so step 4 is really only
needed the first time — but it only *runs* the full sync when the schema
sources changed since the last successful one (a content hash is recorded
under `.cache/`), which keeps restarts fast. Pass `--sync` to force a
sync regardless; a failed sync never records the hash, so the next boot
re-syncs.

Check the endpoint:

```bash
curl -s http://localhost:3200/api/notes
```

```bash
curl -s -X POST http://localhost:3200/api/notes -H 'Content-Type: application/json' -d '{"title":"first"}'
```

## What reloading does and does not do

The dev master supervises a worker process and decides per changed file
([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)):

| Changed file | What happens |
| --- | --- |
| `server.config.ts`, anything under `src/api/` | worker exits 42, master restarts it |
| a **newly created** `.tsx` or `.jsx` | worker exits 42, master restarts it |
| `.ts`, `.js`, `.tsx`, `.jsx`, `.html`, `.vue` | route caches cleared, browser reloaded |
| `.css` | stylesheet hot-swapped in the browser |

**Adding a page costs a restart; editing one does not.** Bun caches the
directory listing it resolved an import against, so a `.tsx` created after the
worker booted cannot be imported at any specifier — the page 500s with
`Cannot find module` — until the process restarts. The watcher spots it from the
`rename` event and restarts for you (~440 ms), which is why a brand-new page
takes a beat longer to appear than an edit to an existing one (~15 ms).

One thing to know about your editor: an in-place save keeps the fast path, but a
writer that *replaces* the file — shell redirection (`> file`), or an editor
that saves atomically by writing a temp file and renaming it over the original —
looks identical to a creation and pays the restart on every save. If your dev
loop restarts on saves you did not expect, that is why.

API routes are also re-imported per request in dev with a cache-busting
`?v=<mtime>`
([packages/core/src/handlers/routes/api.ts](../../packages/core/src/handlers/routes/api.ts)),
and edits under the api directory restart the worker as well — which is what
picks up changes to a route's *imports*. `.tsx` pages take the cheap path
instead: `TSXHandler` busts the module cache with the page file's mtime
([packages/core/src/handlers/assets/tsx.ts](../../packages/core/src/handlers/assets/tsx.ts)),
so editing the page you are looking at shows up on the next browser reload —
which the watcher triggers for you — without restarting the process.

**But for pages, only the page file's mtime is checked.** A component or helper
your `.tsx` page imports — a shared `Layout.tsx`, say — stays cached until a
restart. That is the deliberate trade: editing the page itself, the
overwhelmingly common loop, is instant; after editing a shared component,
restart the dev server (Ctrl+C and rerun, or touch `server.config.ts`).

If the dev server dies, open pages show a "dev server disconnected" overlay
after a few seconds instead of failing silently, and reload themselves when it
comes back. Errors the server pushes over the same socket appear as a
dismissable overlay (click or Esc) and clear on the next successful reload.

Live reload is a WebSocket the framework injects into every HTML response in dev
mode; it does not exist in production
([packages/core/src/utils/http/html.ts](../../packages/core/src/utils/http/html.ts)).

## Error pages

Drop an `error.html` or `error.tsx` in `src/` and it serves every error under
that directory. `error-404.tsx` handles just 404s. The lookup walks up from the
requested path, trying `error-<code>` then `error` at each level, so
`src/blog/error.html` covers `/blog/*` and `src/error.html` covers the rest
([packages/core/src/handlers/core/$error.ts](../../packages/core/src/handlers/core/$error.ts)).

Custom HTML and TSX error pages are served with the real error status:
`applyErrorStatus` in
[packages/core/src/router.ts](../../packages/core/src/router.ts) stamps the
error's code (400–599) onto the rendered response, so `GET /nope` on an app
with `src/error-404.html` returns `404` with the custom page as its body. JSON
errors under `/api/` carry their own status as before.

## Next

- [Project structure](project-structure.md) — the full directory map.
- [Routing](../guides/routing.md) — dynamic segments, priority, mounts.
- [Queries](../orm/queries.md) — beyond `selectAll`.
- [server.config.ts](../configuration/server-config.md) — the rest of the options.
