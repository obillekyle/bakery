# Troubleshooting

Symptoms, and what the framework is actually doing when you see them. Every
entry names the file it was checked against, because the useful half of a
troubleshooting note is usually the mechanism rather than the fix.

## Startup

### The app boots on defaults and ignores `server.config.ts`

`server.config.ts` is resolved against `process.cwd()`, not against the
framework or the repo root (`packages/core/src/core/config.ts`). So is `root`,
so are `bakery` and the cache directory, and so is the schema. Running the CLI
from the repo root instead of the application directory silently gives you a
*different application* — one with no config at all. That is why the root
`package.json` scripts `cd apps/example` first.

Absence is tolerated on purpose: zero-config boot is a supported feature, and
the defaults (`root: 'src'`, port 3000, host `0.0.0.0`) are a working config. So
a config in the wrong place produces no error, only different behaviour.

### `server.config.ts exists but failed to import — refusing to start on the default config`

The file is there and does not parse or does not evaluate. This is treated as
distinct from absence, and the two modes differ
(`packages/core/src/core/config.ts`):

- **Production throws**, and the entry's catch logs `Config init failed: …` and
  exits 1.
- **Development boots anyway**, loudly — a crash would just loop the watcher —
  and the startup banner restates the error.

It used to log one line and boot on `defaultConfig` in both modes, which meant
port 3000, no plugins and no hosts while the developer debugged the vanished
dashboard rather than the config that never parsed.

### `EADDRINUSE` / the port is already taken

The port is `process.env.PORT` → `port` in `server.config.ts` → `3000`
(`packages/cli/src/worker.ts`). **There is no port flag** — the parser only
recognises `--dev`, `--sync`/`-s`, `--threads`/`-t` and the internal worker
markers, and anything else falls through to the *production* branch. `bakery
--port 8080` starts a production server on the configured port and tells you
nothing (`packages/cli/src/index.ts`). Use the environment variable:

```bash
PORT=8080 bunx bakery
```

The same silence applies to `bakery --help`, which does not exist. See
[CLI reference](cli.md#flags).

## Development

### The dev server restarts far more often than I expect

Three things restart the worker, and only three
(`packages/core/src/compiler/dev-service.ts`):

1. A change to `server.config.ts`.
2. A change anywhere under the configured api directory.
3. **Creating** a `.tsx` or `.jsx` file.

The third is the surprising one. Bun caches the directory listing it resolved an
import against, so a page that did not exist when the worker booted cannot be
imported at any specifier — including a freshly cache-busted one — and the page
500s with `Cannot find module` until the process restarts. `isCreatedRouteModule`
detects this from the watcher's `rename` event plus the file still existing.

The detection is deliberately over-broad in one direction: a writer that
*replaces* a file rather than overwriting it in place reports `rename` for an
ordinary edit too. Shell redirection (`> file`) does this, and so does any
editor that saves atomically by writing a temp file and renaming it over the
original. Those saves pay the restart (~440 ms) every time, where an in-place
save stays on the fast path (~15 ms). If your loop feels slow, check your
editor's atomic-save setting before you look anywhere else.

### Editing a shared component changes nothing until I restart

Only the route file's own mtime is cache-busted
(`packages/core/src/handlers/assets/tsx.ts`). A `Layout.tsx` your page imports
stays in Bun's module registry until the process restarts. That is the trade for
making the common loop — editing the page itself — instant.

Touching `server.config.ts` is the cheapest way to force it, since that is a
restart trigger.

The equivalent for API routes does not exist, because edits under the api
directory already restart the worker.

### A CSS change reloads the whole page instead of hot-swapping

The client matches the changed file against `link[rel="stylesheet"]` elements
whose URL is same-origin and whose `pathname` is **exactly** the changed path
(`packages/core/src/client/livereload.ts`). Anything else falls through to a
reload:

- CSS inside a `<style>` block, or imported from another stylesheet with
  `@import` — there is no `<link>` for it.
- A `<link href>` that does not resolve to the same pathname the watcher
  reported.

A `.tsx` or `.html` change is different again: the client re-fetches the current
URL and DOM-patches the body if the markup differs by less than 15%, and does a
full reload above that.

### The browser does not reload after I change an API route

It should, but by a different route than a normal reload. A backend change exits
the worker; the live-reload socket closes; the client backs off and reconnects,
and on reconnect it reloads the page outright
(`packages/core/src/client/livereload.ts`). If the page never reloads, the
worker did not come back — check the terminal for the startup error.

After about seven seconds of downtime the page shows a "dev server disconnected"
overlay rather than sitting silent. Errors the server pushes over the same
socket appear as a dismissable overlay (click or Esc).

### `tsconfig.json` keeps getting rewritten

The dev worker syncs `compilerOptions.paths` from `config.importMap` into the
application's own `tsconfig.json` on every boot
(`packages/core/src/compiler/tsconfig-sync.ts`). Three things about it are worth
knowing:

- It writes **only** when the computed `paths` differ from what is on disk, so a
  repeated `TSConfig paths synced` line means something is genuinely flapping —
  usually an `importMap` entry computed from a path that moves.
- `paths` is **replaced**, not merged. Hand-written path aliases in that file
  will be removed. Put them in a base config the app's `tsconfig.json` extends.
- `compilerOptions.baseUrl` is deleted unconditionally.

Comments and trailing commas are fine — the file is read with a JSONC parser.
Failures are logged as `TSConfig sync error: …` and never abort the boot.

## Routing

### My `.tsx` page returns 404

There is no route table and no route listing in the startup banner, so there is
nothing to check for a "registered" route — resolution happens per request
against the filesystem. In order of likelihood:

1. **No `default` export.** A module without one resolves to `null`, which every
   caller treats as 404 (`packages/core/src/handlers/core/$dynamic.ts`). A
   module that throws on import is a different case: it becomes a 500 with the
   stack shown in development and redacted in production.
2. **The extension is `.jsx`.** `TSXHandler` is configured for `tsx` only
   (`packages/core/src/handlers/assets/tsx.ts`); no handler serves `.jsx`. The
   watcher does watch it, which makes the file look live while nothing routes
   it.
3. **A bracketed path was requested literally.** `DynamicHandler.canHandle`
   refuses any path spelled like a route template, so `/blog/[id]` and
   `/docs/[...slug]` are 404 by design (`$dynamic.ts`).
4. **A bracket-named directory.** Discovery never descends them — neither
   `[id]/[...slug].tsx` nor `[category]/[slug].tsx` is reachable. Params work
   within the final *filename* only.

If the page renders but the wrong file answered, it is priority rather than
specificity: see
[Routing → Priority beats specificity](../guides/routing.md#priority-beats-specificity-across-handlers).

### A file exists in `src/` but is refused

Three separate mechanisms, each with a different response:

- **Blocked globs** — `403 Forbidden` as plain text, applied after routing and
  only when the winning handler serves files off disk. The full pattern list is
  in [Server config → Blocked paths](../configuration/server-config.md#blocked-paths).
  Matching folds case and Win32 trailing dots, so `/PACKAGE.JSON` is refused
  alongside `/package.json`.
- **A `.forbidden` marker.** Any directory between the target and the serve root
  containing a file named `.forbidden` makes everything below it unreachable
  (`packages/core/src/utils/fs.ts`). The probe is not cached across requests, on
  purpose — dropping the marker takes effect on the next request, and removing
  it likewise.
- **Containment.** A resolved path that lands outside the root it was resolved
  against is `403`, before any handler runs.

`config.blocked` can only ever *add* to the built-in list; nothing an
application writes can shorten it.

### `POST /api/...` returns 403 but works from curl

The same-origin CSRF guard. Unsafe methods must carry a same-site
`Sec-Fetch-Site` or a matching `Origin`; requests with **neither** header are
allowed through, which is why curl and server-to-server calls are unaffected and
a browser fetch from another origin is not
(`packages/core/src/utils/http/csrf.ts`). Full treatment, including what to do
about a legitimately cross-origin client, is in
[API routes → CSRF](../guides/api-routes.md#csrf-why-your-post-returns-403).

### `429 Too Many Requests` from my own machine

The per-IP rate limit is **on by default** — a 100-request burst refilling at 10
per second (`packages/cli/src/worker.ts`). The startup banner announces it
whenever the default is in effect. A page that fans out to many assets or a load
test will hit it. Set `rateLimit` in `server.config.ts`, or `rateLimit: false`
to turn it off. In cluster mode the budget is shared across workers, not
per worker.

### `body` is empty or missing fields

`processBody` (`packages/core/src/utils/http/body.ts`) branches on method and
content type, and **swallows parse failures into `{}`** — so malformed JSON
looks identical to no body at all:

| Request | What `body` contains |
| --- | --- |
| `GET` / `HEAD` | the query string, as an object. There is no body read at all |
| `Content-Type: application/json` | the parsed JSON |
| form-urlencoded or multipart | the form fields; a repeated key becomes an array |
| `application/*`, `image/*`, `audio/*`, `video/*`, `model/*` | `{ file: Blob }` |
| anything else | `{ data: '<raw text>' }` |

So a `POST` sent without `Content-Type: application/json` lands in that last row
as `{ data: '{"title":"x"}' }` rather than `{ title: 'x' }`. Route params are
merged in last and overwrite same-named query fields.

### `413 Payload Too Large`

`maxBodySize` in `server.config.ts` is passed straight to `Bun.serve` as
`maxRequestBodySize` (`packages/cli/src/worker.ts`). The default is 20 MB
(`packages/core/src/core/config.ts`); the rejection comes from Bun, before any
handler runs, so nothing in your route can catch it.

## Database

### `db:sync` refuses a destructive plan

By design, and it depends on exactly one thing:
`process.env.NODE_ENV === 'production'` (`isProductionSync` in
`packages/orm/src/sync/engine.ts`). With it set, a plan that drops or renames a
table or column, rebuilds a table, updates a view or drops an index exits 1
unless you pass `--force-sync`. Without it, you get an interactive prompt — and
a non-TTY declines rather than treating an unanswerable prompt as consent.

If a production host is prompting instead of refusing, `NODE_ENV` is not set.
That is the whole of the guard; no other flag or mode contributes to it.

### A destructive sync aborts complaining about the backup

A destructive plan requires a backup to have actually been written. If the dump
fails, the database is in-memory, or the dump tool is missing, the sync aborts
rather than proceeding (`packages/orm/src/sync/engine.ts`). `backups` in
`server.config.ts` caps how many are kept.

### A renamed column was offered as "drop and add"

A disappearing column and an appearing one are indistinguishable from a rename,
so the engine asks rather than guessing: it prompts with the best fuzzy match
(bigram similarity over the snake-cased names), every remaining candidate, and
"drop it" (`packages/orm/src/sync/helpers.ts`). **Answering wrongly drops the
column.**

Say it in the schema instead, with `old()`. See
[Schema sync → Renames](../orm/sync.md#renames).

### Resetting the database

Stop the server and delete the SQLite file from the application's data directory
(`Bakery.dataDir` — see
[Project structure](../getting-started/project-structure.md#generated-directories)).
The next boot creates an empty database; `db:sync` applies the schema to it.

Deleting the cache directory is always safe and never affects data — the two are
deliberately not nested for exactly this reason. Note that the session store
lives with the data, not with the cache, so a reset logs everyone out even when
the ORM points at MySQL or Postgres.

## Frequently asked

### Does Bakery do React?

No. `.tsx` pages are rendered to an HTML string on the server by Bakery's own
JSX runtime (`packages/core/src/core/jsx.ts`) — there is no virtual DOM, no
hydration and no client-side component model. Children are escaped unless they
came from `createElement` itself, so interpolating user data is safe by default.

For client-side interactivity, a page's same-stem `.ts` sibling is compiled and
injected as a module script. You can also serve a React or Vue bundle as ordinary
static files; the framework will not hydrate it for you.

Vue *components* are supported, but through a plugin rather than in core: see
[Vue](../plugins/vue.md).

### Can I deploy to a serverless platform?

Not usefully. Bakery is a long-running stateful process: it owns a `Bun.serve`,
WebSocket connections, an in-memory cache tier flushed to SQLite on a 30-second
timer, and — by default — an embedded database on local disk. A VPS, a container
host, or anything that gives you a persistent volume and a process that stays
up. The volume requirement is the hard one; see
[Production → Directories](../deployment/production.md#directories-what-must-persist).

### Why not just use Express or Hono?

Different job. Those are routers you assemble a stack around. Bakery is opinionated
about the whole surface — filesystem routing, server-rendered JSX, sessions, an
ORM with schema sync, a dev loop — and the parts are designed against each other
rather than composed. If you want to pick your own pieces, pick your own pieces.

## Next

- [CLI reference](cli.md) — every flag, exit code and environment variable.
- [Architecture](architecture.md) — the request pipeline end to end.
