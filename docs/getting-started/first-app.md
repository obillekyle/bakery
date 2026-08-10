# Your first app

We will build a small notes app: one server-rendered page, one JSON endpoint,
one table. There is no build step at any point.

Start from the scaffolder rather than an empty directory — it writes the two
files that are easy to get wrong (`tsconfig.json` and `orm/index.ts`) and
nothing else you would not have written yourself.

## 1. Create it

```bash
bun create bakery notes
```

Answer the prompts — or take the defaults with `--yes`, which is the ORM in and
no plugins. Then:

```bash
cd notes
```

You have a working app already. Everything below edits it.

## 2. What you got

```
notes/
  package.json          dev / start / typecheck / db:sync
  tsconfig.json         extends @bakery-framework/core/tsconfig.server.json
  server.config.ts      root, port
  src/
    index.tsx           /
    script.ts           /script.js
    api/notes.ts        /api/notes
  orm/
    tables.ts  views.ts  indexes.ts  index.ts
  scripts/db-sync.ts
```

Two of those repay a closer look before you change anything.

**`tsconfig.json` repeats three `jsx*` options its `extends` already sets.** That
duplication is load-bearing: Bun's runtime does not follow `extends` into a
package specifier, so without them every `.tsx` page 500s with
`Cannot find module react/jsx-dev-runtime` while `tsc` stays perfectly clean.
The generated file carries a `$comment` saying so. Keep them.

**`orm/index.ts` is what makes the ORM typed.** It re-exports the tables and
declares them into the framework's schema registry:

```ts no-check — module augmentation plus a relative import of the reader's own tables.ts; neither resolves outside a real app
import type { InferOptionals, InferSchema, InferViews } from '@bakery-framework/orm'
import * as tables from './tables'
import * as views from './views'

export * from './tables'
export * from './views'
export * from './indexes'

type Model = typeof tables & typeof views

declare module '@bakery-framework/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: InferSchema<Model>
      DBOptionals: InferOptionals<Model>
      Views: InferViews<Model>
    }
  }
}
```

That `declare module` block is declaration merging, the same pattern TanStack
Router and vue-router use, and it exists so the framework never has to import an
app-owned file
([packages/orm/src/schema-registry.ts](../../packages/orm/src/schema-registry.ts)).

**Deleting it is legal.** Without a registration every table and column falls
back to permissive `any`, and everything still runs and typechecks — the ORM is
just untyped. The *runtime* never reads the registry; schema values are loaded by
path.

The split between `tables.ts` and `index.ts` exists because
`db:sync --choose=db` regenerates the tables from the database — anything
hand-written beside them would be collateral
([packages/orm/src/sync/load.ts](../../packages/orm/src/sync/load.ts)).

## 3. Declare the schema

Replace `orm/tables.ts`:

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
`Field.Text` wherever there is a default, because MySQL refuses a literal DEFAULT
on a TEXT column.

The generated `orm/views.ts` and `orm/indexes.ts` refer to the tables you just
replaced, so empty them out too — a view or index over a table that no longer
exists is a typecheck error, which is the schema registry doing its job.

> `schema.ts` and `orm/schema.ts` are gitignored by the generated `.gitignore`
> at any depth. `orm/tables.ts` is not, so this file is committed normally.

## 4. Create the database

```bash
bun run db:sync
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

## 5. Rewrite the API route

`src/api/notes.ts` — reachable at `/api/notes`, because the file is `notes.ts`
under `<root>/api`:

```ts
import { defineRoute, response } from '@bakery-framework/core'
import DB from '@bakery-framework/orm'

export default defineRoute<{ title?: string; body?: string }>(
  async (req, body) => {
    if (req.method === 'POST') {
      const title = String(body.title ?? '').trim()
      if (!title) return response.json.error(400, 'title is required')

      await DB.Insert.into('notes')
        .values({ title, body: body.body ?? '' })
        .run()
      return response.json.success('created')
    }

    const notes = await DB.from('notes').selectAll('notes').array()
    return response.json.success('ok', notes)
  },
)
```

Four things worth knowing:

**The second argument is the parsed body.** For `GET` and `HEAD` it is the query
string as an object; otherwise it is the parsed JSON, form data, or `{ file }`
for a binary content type
([packages/core/src/utils/http/body.ts](../../packages/core/src/utils/http/body.ts)).
Dynamic route parameters are merged into the same object.

**`defineRoute<T>` states a contract, it does not enforce one.** The body comes
from the client, so the check above is not optional. To have the framework
enforce it instead, pass a validator and the handler only runs on a body that
satisfies it:

```ts no-check — `mySchema` stands in for a Standard Schema the reader supplies
export default defineRoute({ body: mySchema }, async (req, body) => {
  // `body` is the parsed value; a rejection answered 400 before you got here.
})
```

`body` takes any [Standard Schema](https://standardschema.dev) — zod, valibot,
arktype — or a plain function returning the parsed value or throwing. Bakery
bundles none of them and depends on none of them. See
[API routes](../guides/api-routes.md).

**Every JSON body uses one envelope**: `{time, status, message, data}`.
`response.json.success(message, data)` and `response.json.error(status, message)`
are the only two shapes you need. `time` is filled in by the router with the
request's elapsed milliseconds.

**Unsafe methods must be same-origin.** `ApiHandler` runs a CSRF guard before
resolving the route: `GET`/`HEAD`/`OPTIONS` pass, anything else is rejected with
403 if `Origin` disagrees with the request URL or `Sec-Fetch-Site` says
cross-site
([packages/core/src/handlers/routes/api.ts](../../packages/core/src/handlers/routes/api.ts)).
A request with *neither* header — curl, a server-to-server call — is allowed,
because browsers always send at least one. That is the intended trade-off, not an
oversight; it means the guard protects browser users without breaking API
clients.

## 6. Rewrite the page

`src/index.tsx` — served at `/`, because `index` is the fallback route name:

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

Exporting the JSX directly — without `HTMLBody`, which is what the scaffolder
generates — also works. `createElement` returns a `SafeHtml`, a `String`
*subclass* used so the renderer can tell already-escaped markup from user text
([packages/core/src/core/jsx.ts](../../packages/core/src/core/jsx.ts)), and this
used to trip the handler's "is this an object?" JSON check
(`typeof new String('') === 'object'`), serving the page as
`{"status":200,…,"data":"<html>…"}`. The handler now unboxes `SafeHtml` back to a
primitive string before that check
([packages/core/src/handlers/assets/tsx.ts](../../packages/core/src/handlers/assets/tsx.ts)).

`HTMLBody` is still worth using: it prepends the `<!DOCTYPE html>` (an unwrapped
page is served without one) and, if you return a fragment rather than a full
`<html>` document, wraps it in a minimal one.

## 7. Rewrite the browser script

`src/script.ts`:

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
the page requests `/script.js`. `TSHandler` strips a trailing `.js`, compiles the
TypeScript through `Bun.build`, and caches the output under `.cache/ts_cache`
([packages/core/src/handlers/assets/ts.ts](../../packages/core/src/handlers/assets/ts.ts)).
Requesting `/script.ts` directly works too. There is no bundler config and no
output directory.

There is also a convention you get for free: if a page is `foo.tsx` and a
`foo.ts` or `foo.css` sits beside it, the corresponding `<script>` or `<link>`
tag is injected automatically
([packages/core/src/handlers/assets/tsx.ts](../../packages/core/src/handlers/assets/tsx.ts)).
The generated `index.tsx` names its script explicitly instead, so you can see
where it comes from.

## 8. Run it

```bash
bun run dev
```

```
[I] serve   Starting server in development mode...
[I] db-sync schema.ts is perfectly synced with Database!
[I] serve   Server running at:
[I] serve     ➜ Local  : http://localhost:3000
```

Development mode checks the schema before every boot, so step 4 is really only
needed the first time — but it only *runs* the full sync when the schema sources
changed since the last successful one (a content hash is recorded under
`.cache/`), which keeps restarts fast. Pass `--sync` to force one; a failed sync
never records the hash, so the next boot re-syncs.

Check the endpoint:

```bash
curl -s http://localhost:3000/api/notes
```

```bash
curl -s -X POST http://localhost:3000/api/notes -H 'Content-Type: application/json' -d '{"title":"first"}'
```

Then `bun run typecheck` before you commit — it is `tsc --noEmit` against the
config the scaffolder wrote, and it is the only gate that sees the schema
registration doing its work.

## What reloading does and does not do

The dev master supervises a worker process and decides per changed file
([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)):

| Changed file | What happens |
| --- | --- |
| `server.config.ts`, anything under `src/api/` | worker exits 42, master restarts it |
| a **newly created** `.tsx` or `.jsx` | worker exits 42, master restarts it |
| `.ts`, `.js`, `.tsx`, `.jsx`, `.html`, `.vue` | route caches cleared, browser reloaded |
| `.css` | stylesheet hot-swapped in the browser |

**Adding a page costs a restart; editing one does not.** Bun caches the directory
listing it resolved an import against, so a `.tsx` created after the worker
booted cannot be imported at any specifier — the page 500s with
`Cannot find module` — until the process restarts. The watcher spots it from the
`rename` event and restarts for you (~440 ms), which is why a brand-new page
takes a beat longer to appear than an edit to an existing one (~15 ms).

One thing to know about your editor: an in-place save keeps the fast path, but a
writer that *replaces* the file — shell redirection (`> file`), or an editor that
saves atomically by writing a temp file and renaming it over the original — looks
identical to a creation and pays the restart on every save. If your dev loop
restarts on saves you did not expect, that is why.

API routes are also re-imported per request in dev with a cache-busting
`?v=<mtime>`
([packages/core/src/handlers/routes/api.ts](../../packages/core/src/handlers/routes/api.ts)),
and edits under the api directory restart the worker as well — which is what
picks up changes to a route's *imports*. `.tsx` pages take the cheap path
instead: `TSXHandler` busts the module cache with the page file's mtime, so
editing the page you are looking at shows up on the next browser reload — which
the watcher triggers for you — without restarting the process.

**But for pages, only the page file's mtime is checked.** A component or helper
your `.tsx` page imports — a shared `Layout.tsx`, say — stays cached until a
restart. That is the deliberate trade: editing the page itself, the
overwhelmingly common loop, is instant; after editing a shared component, restart
the dev server (Ctrl+C and rerun, or touch `server.config.ts`).

If the dev server dies, open pages show a "dev server disconnected" overlay after
a few seconds instead of failing silently, and reload themselves when it comes
back. Errors the server pushes over the same socket appear as a dismissable
overlay (click or Esc) and clear on the next successful reload.

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
error's code (400–599) onto the rendered response, so `GET /nope` on an app with
`src/error-404.html` returns `404` with the custom page as its body. JSON errors
under `/api/` carry their own status as before.

## Next

- [Project structure](project-structure.md) — the full directory map.
- [Routing](../guides/routing.md) — dynamic segments, priority, mounts.
- [Queries](../orm/queries.md) — beyond `selectAll`.
- [server.config.ts](../configuration/server-config.md) — the rest of the options.
</content>
