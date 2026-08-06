# Static assets

There is no `public/` convention in the usual sense and no asset pipeline to
configure. Files under the serve root are served as they are, and a handful of
specialised handlers sit above the fallback to transform particular URL shapes.

All of them are entries in the `fetch` registry, so their relative order is a
priority number, not a chain of `if`s. See [Routing](routing.md) for the full
table.

## The fallback: `StaticHandler` (priority 0)

Anything no other handler claims lands here. `canHandle` returns `true`
unconditionally (`packages/core/src/handlers/assets/static.ts`), which is why
a missing file produces a 404 from this handler rather than from the router.

```
src/styles/global.css   →  /styles/global.css
src/images/vector.svg   →  /images/vector.svg
```

Compressible types are pre-compressed into `.bakery/cache/static/` keyed by the
file's mtime and hostname (`static.ts`); everything else is streamed
directly from `Bun.file`. ETags are attached by `processResponse` on the way out,
so conditional requests get a 304 without touching disk.

## File resolution and containment

Four handlers — static, public, image and node-module — resolve through one
function, `getStatic` (`packages/core/src/handlers/core/$static.ts`). It is
the literal counterpart to route resolution: no extensionless URLs, no `[param]`
matching, just "which file is at this path, and am I allowed to serve it".

Three checks, all of which must pass:

1. The resolved path must be inside the root (a prefix test, after normalising
   `..`).
2. `fs.isForbidden` must be false — this walks from the file up to the root
   looking for a `.forbidden` marker file (`utils/fs.ts`). Dropping an empty
   `.forbidden` into a directory makes that whole subtree unservable.
3. The path must exist and not be a directory.

A route mount wins over the configured roots: when a plugin has mounted a prefix,
the mount directory becomes both the search root *and* the containment boundary,
so a mounted directory cannot be traversed out of.

## What is never served

`config.blocked` is compiled into a single `Bun.Glob` at startup, on top of a
fixed default list (`packages/core/src/utils/constants.ts`). The check runs in
`handleRequest` before any handler is consulted and returns a plain-text
`403 Forbidden`.

The defaults block, anywhere in the tree:

```
.env  *.env  *.sql  *.db  *.json  *.yaml  *.yml  *.lock  *.exe  .gitignore
.bakery/**  .data/**  _internal/**  .git/**  .vscode/**  node_modules/**
server.config.ts  schema.ts
```

**`*.json` is on that list.** A `manifest.json` or a data file under `src/` is a
403, not a 404, and no amount of correct pathing will fix it. Serve JSON from an
API route instead.

Your own entries are prefixed with `**/` if they do not already start with it
(`core/config.ts`), so `blocked: ['secret.txt']` blocks that filename at
every depth:

```ts
import { defineConfig } from '@bakery/core'

export default defineConfig({
  root: 'src',
  blocked: ['*.bak', 'drafts/**'],
})
```

Per-host `blocked` replaces the app-level list rather than extending it — the
framework defaults are always re-applied (`core/config.ts`).

## Uploads: `PublicHandler` (84)

`/uploads/*` is served from `Bakery.publicRoot`, which is `<cwd>/public` — a
sibling of `src/`, **not** a directory inside it
(`packages/core/src/core/bakery.ts`).

```
public/uploads/avatar.png   →  /uploads/avatar.png
```

This is the one place a URL prefix does not correspond to a path under the serve
root, and it catches people out: `src/uploads/` is unreachable at `/uploads/`,
because `PublicHandler` claims the prefix at priority 84 and returns its own 404
rather than falling through to `StaticHandler`.

The separation is intentional — user-uploaded files should not sit in the
directory the router will happily execute `.ts` and `.tsx` from.

## Images: `ImageHandler` (85)

Any path ending in `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` or `.bmp` is claimed
by `ImageHandler` (`packages/core/src/handlers/assets/image.ts`), which
**re-encodes everything to WebP** and caches the result under
`.bakery/cache/images/`.

Add `;<size>` before the extension to get a resized copy:

```html
<img src="/images/hero.png" />        <!-- full size, WebP -->
<img src="/images/hero;320.png" />    <!-- shortest edge ≈ 320px, WebP -->
```

The size is snapped to a multiple of 32 and clamped to 16…4096
(`image.ts`), so `;300`, `;310` and `;320` all produce the same file. That
clamping is load-bearing: the cache key is derived from the *resolved source
path*, not the requested URL, precisely so that a client cannot mint unlimited
cache entries and unlimited re-encodes by varying the number (`image.ts`).

Resizing preserves aspect ratio and never upscales — `scale` is capped at 1.

`ImageHandler` searches both `Bakery.serveRoot` and `Bakery.publicRoot`, in that
order. Because it outranks `PublicHandler`, it applies the same containment and
`.forbidden` checks itself; an image under a protected directory stays protected.

## Google Fonts: `GoogleFontHandler` (87)

Any `https://fonts.googleapis.com/css2` URL in your HTML is rewritten to `/_gf/`
during injection (`utils/http/html.ts`), so this works without you doing
anything:

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700" rel="stylesheet">
```

The handler fetches the stylesheet with a desktop user-agent, rewrites every
`https://fonts.gstatic.com` inside it to `/_gf/gstatic`, and caches the result
(`handlers/assets/google-font.ts`). The font files themselves are then
proxied and cached the same way. The net effect is that no browser request leaves
your origin for fonts.

The cache has no expiry — it is keyed on the request path and query only, with a
`null` mtime, so entries live until `.bakery/cache/gf_cache` is deleted. An
upstream failure returns 502.

## Node modules in the browser: `NMHandler` (80)

`/_nm/<package>/<file>` bundles the file out of `node_modules` and serves it as
JavaScript (`handlers/assets/nm.ts`), with a containment check against
`<cwd>/node_modules`.

You do not normally write those URLs. At startup, every entry in your
`package.json` `dependencies` is turned into an import-map entry pointing at
`/_nm/...` (`utils/http/dom.ts`), and the import map is injected into
every HTML page. So a browser-side `import { x } from 'some-pkg'` resolves.

`config.importMap` adds to or overrides that map. Relative values are normalised
to absolute URLs.

## Framework and virtual assets: `VirtualAssetHandler` (90)

- `/_client/utils.js` — the browser runtime (`Bakery.params()`, `Try`, `is`,
  `escapeHTML`). Bundled, not merely transpiled, because the browser cannot
  resolve the relative imports a transpile leaves behind.
- `/_client/livereload.js` — dev only; `canHandle` refuses it in production
  (`virtual-asset.ts`).
- `/_virtual/<id>` — assets registered by the compiler under a generated id.

These resolve against the framework's own install directory, not your app.

## TypeScript for the browser: `TSHandler` (50)

A `.ts` file under the serve root is compiled and served as JavaScript. Both
spellings work, because the extension in a URL is a hint rather than a
requirement (`handlers/assets/ts.ts`, `:23`):

```html
<script src="/script/index.ts" defer></script>
<script src="/script/index.js" type="module"></script>
```

Output is cached under `.bakery/cache/ts_cache/` keyed by hostname and mtime.

Note the priority: `TSHandler` is 50, below `TSXHandler` (60) and `HTMLHandler`
(55). A `.ts` file whose stem collides with a `.tsx` page will lose — `page.ts`
next to `page.tsx` is treated as that page's client script and injected
automatically (see [Routing](routing.md#sibling-ts-and-css-files-are-auto-injected)).

## Cache locations

Everything derived lives under `.bakery/cache/`, which is safe to delete:

```
.bakery/cache/static/     pre-compressed static files
.bakery/cache/images/     WebP masters and resized variants
.bakery/cache/ts_cache/   compiled TypeScript
.bakery/cache/html/       assembled HTML pages
.bakery/cache/nm_cache/   bundled node_modules
.bakery/cache/gf_cache/   Google Fonts CSS and font files
.bakery/cache/virtual/    framework client assets
```

The database and its backups live in `.data/`, deliberately outside `.bakery/`,
so that clearing the cache cannot destroy data
(`packages/core/src/core/bakery.ts`).

The whole cache directory is wiped automatically when the framework version or
the mode (dev/production) changes (`core/config.ts`).
