# Vue plugin

`@bakery-framework/plugin-vue` adds `.vue` single-file components as a first-class route
type, alongside `.tsx`, `.html` and `.ts`. A `.vue` file under the serve root is
a page; a `.vue` file imported by another component is a module. Components
render **in the browser** — there is no SSR — but each page may carry a
`<script server>` block that runs on the server, per request, and whose exports
become the component's data.

## Install

Vue is a peer dependency of the plugin:

```bash
bun add vue
```

`setup()` checks that `vue/package.json` resolves and calls `process.exit(1)`
with a log line if it does not — a missing Vue is a boot failure, not a runtime
surprise ([`vue/src/setup.ts`](../../packages/plugins/vue/src/setup.ts)). The
version string, and the runtime served at `/_vue/<version>.<build>.js`, are
resolved from the *application's* directory, so the app controls which Vue it
ships. The SFC compiler (`@vue/compiler-sfc`, a dependency of `vue`) is
imported lazily on the first compile, and throws "compiler-sfc not available"
if it is missing.

## Register

```ts
import { defineConfig } from '@bakery-framework/core'
import vuePlugin from '@bakery-framework/plugin-vue'

export default defineConfig({
  root: 'src',
  plugins: [
    vuePlugin({
      // Tags the SFC compiler should leave alone instead of resolving as
      // components. Accepts an array or a predicate.
      customElements: ['my-widget'],
      // Passed through to @vue/compiler-sfc's compileTemplate.
      compilerOptions: {},
      // 'runtime' (default) or 'full'. See below.
      build: 'runtime',
    }),
  ],
})
```

`iconify-icon` is always treated as a custom element, whether or not you list
it. `customElements` is applied where templates are compiled — on the server —
so it works identically on both builds; it does not require `'full'`.

**`build` picks which Vue the browser downloads.** The default, `'runtime'`,
is ~170KB smaller and is all a Bakery app normally needs: every SFC template
becomes a render function on the server, so the browser never compiles one.
Opt into `'full'` only when a component hands Vue a raw `template:` string at
runtime — those are compiled in the browser, and on the runtime build they
fail with Vue's "runtime compilation is not supported" error naming the
component.

With `'full'`, if `customElements` is a *function*, it is stringified into the
browser bundle so runtime-compiled templates agree with the build-time
decision — a predicate that closes over server state will not survive that,
and the runtime check falls back to the built-in tag
([`vue/src/compile.ts`](../../packages/plugins/vue/src/compile.ts)). On
`'runtime'` that bridge is not emitted, because the runtime build has no
in-browser compiler to consult it.

Registering the plugin does three things
([`vue/src/setup.ts`](../../packages/plugins/vue/src/setup.ts)):

- `VueHandler` joins the fetch registry at priority **58** — below `TSXHandler`
  (60), above `HTMLHandler` (55).
- `VueErrorHandler` joins the error registry at **18**, so `error.vue` and
  `error-*.vue` files render error pages.
- `Bakery.config.importMap['vue']` points at `/_vue/<version>.<build>.js`
  (e.g. `/_vue/3.5.41.runtime.js`), a self-hosted build of the Vue ESM
  runtime. No CDN. The build variant is part of the filename so switching
  `build` in `server.config.ts` can never serve the other variant out of the
  chunk cache.

## How a page is served

A request for `/reports` resolves `reports.vue` under the serve root and returns
an HTML shell containing an empty `<div id="app">`, a stylesheet link if the
component has styles, and `<script type="module"
src="/reports?__vue_script=root">`. The browser then fetches the same route
three more ways, distinguished by query string:

| Request | Serves |
| --- | --- |
| `/reports` | the HTML shell, plus a `<script>` assigning `globalThis.__vue_server` |
| `/reports?__vue_script=root` | the compiled root component, which calls `createApp(...).mount('#app')` |
| `/reports?__vue_script=module` | the compiled component as an importable module (what `import Foo from './Foo.vue'` becomes) |
| `/reports?__vue_css=true` | the compiled, scope-hashed stylesheet |

A request is treated as a script request when `__vue_script` is present, or the
`Accept` header names `text/javascript`, or `Sec-Fetch-Dest` is `script`.

The plugin's `onCompile` hook rewrites every `.vue` import in every compiled
`.ts`/`.js`/`.vue` file to append `?__vue_script=module`, which is what makes
`import Child from './Child.vue'` work in the browser
([`vue/src/index.ts`](../../packages/plugins/vue/src/index.ts)).

### `<meta />` directives

A `<meta />` tag in the file prologue — before any block, comments and
whitespace allowed — configures the page. It is stripped before compilation and
is not part of the template.

```vue
<meta title="Team dashboard" page-only />
```

- `title="…"` — sets the shell's `<title>`, HTML-escaped.
- `module-only` — the file may only be imported; a page request gets 404.
- `page-only` — the file may only be a page; `?__vue_script=module` gets 404.
- `no-layout` — the page renders without its directory's `layout.vue`.

Only the prologue is scanned, so a `<meta charset>` inside a `<template>` is
left alone.

## Layouts

A `layout.vue` file wraps every page in its directory and below; the nearest
ancestor wins, and the page renders into its default `<slot />`:

```html
<template>
  <div class="chrome">
    <nav>…shared navigation…</nav>
    <main><slot /></main>
  </div>
</template>
```

The walk is anchored by the page **file**, not the request URL, so a
catch-all page (`admin/[...slug!].vue`) is wrapped by `admin/layout.vue`
however deep the request goes. Opt a page out with `<meta no-layout />`.

Rules worth knowing:

- `layout.vue` is scaffolding, not a destination: requesting `/admin/layout`
  as a page is a 404, while the module and stylesheet requests every wrapped
  page makes still serve.
- The layout's stylesheet is linked *before* the page's, so a page can
  override its layout the way source order normally implies.
- Layouts do not nest, and a layout never wraps itself. One nearest layout,
  deliberately — nesting needs an ordering story that should be designed,
  not implied.
- Error pages (`error.vue`, `error-*.vue`) are wrapped too, since they are
  served by the same pipeline; give them `<meta no-layout />` if the chrome
  itself is what might be broken.

## Skeletons

A second template block marked `skeleton` shows inside `#app` before the
bundle hydrates — `mount()` replaces it the moment the real component is up:

```html
<template skeleton>
  <div class="pulse">loading shipments…</div>
</template>

<template>
  <ShipmentTable :rows="rows" />
</template>
```

**The skeleton is static markup, injected verbatim, and that is a security
decision, not a shortcut.** It is never compiled and never rendered on the
server, so interpolations do not evaluate and nothing request- or
session-derived can reach it — a server-rendered skeleton cached across
requests would serve one user's data to another. Two consequences: bindings
inside it are inert text, and scoped styles do not apply to it (the scope
attributes are stamped by the compiler it never meets) — style it with plain
classes from an unscoped block.

## `<script server>`

A `<script server>` block is extracted before the SFC compiler ever sees the
file and never reaches the browser. Everything else in the file does, so treat
the boundary as the security boundary: secrets, database access and
authorization belong in the server block.

```vue
<script server>
import DB, { Mutation } from '@bakery-framework/orm'

export const students = await DB.table('students').where('active', 1).array()
export const viewer = req.session.get('userId')

export async function archive(id) {
  await Mutation.Update.table('students').set({ active: 0 }).where('id', id)
  return { ok: true }
}
</script>

<script setup>
import { ref } from 'vue'
const rows = ref(students)
</script>

<template>
  <ul>
    <li v-for="s in rows" :key="s.id">
      {{ s.name }}
      <button @click="archive(s.id)">Archive</button>
    </li>
  </ul>
</template>
```

A file may contain more than one `<script server>` block; they are concatenated
and all of them are removed. The closing-tag scan skips strings, template
literals and comments, so a literal `"</script>"` inside server code does not
truncate the block and leak the remainder into the client bundle
([`vue/src/utils.ts`](../../packages/plugins/vue/src/utils.ts)).

### `req` and `body` are parameters, not globals

The block is compiled into a module whose default export is, literally:

```ts no-check — the generated wrapper, shown for shape; `__bkry_` names are internal
export default async function __bkry_server(
  req: any,
  body: any,
  actionName?: string,
  actionArgs?: any[],
) {
  /* your server block, with `export` rewritten into result assignments */
}
```

So `req` and `body` resolve as function parameters injected by the compiler
([`vue/src/utils.ts`](../../packages/plugins/vue/src/utils.ts)). They are
not ambient globals, and they exist *only* inside a `<script server>` block —
writing `req.headers` anywhere else is a `ReferenceError` at runtime. `body` is
the parsed request body merged with the route params.

Relative imports inside the block are rewritten to absolute paths, because the
compiled module runs from the cache directory. That covers `import(...)` too,
which is the usual way a server block reuses an API handler.

### What the exports mean

| Export form | Meaning |
| --- | --- |
| `export const x = …` | page data — serialised into the HTML and destructured into the client script |
| `export function f()` / `export const f = () => {}` | a **server action** — the client gets an RPC stub of the same name |
| `export async function middleware(req, body)` | runs before everything else; returning a `Response` short-circuits |
| `export default {…}` or `export default fn` | merged into the page data, or returned directly if it is a `Response` |

Data exports are destructured for you: the plugin prepends
`const { students, viewer } = …` to the client script, so template expressions
just work. Function exports are replaced by a `fetch` stub that POSTs to the
same route.

Two things follow from the wrapper's shape and are worth stating plainly:

- **Top-level statements run before `middleware`.** Middleware can stop the
  *response*; it cannot stop top-level code from having already executed. Put
  auth-gated work inside an exported function, not at the top level. The
  generated wrapper says so in a comment
  ([`vue/src/utils.ts`](../../packages/plugins/vue/src/utils.ts)).
- **The block has a 5-second budget.** On timeout or throw, the error is logged
  and the page renders with empty data (`{}`) rather than failing
  ([`vue/src/utils.ts`](../../packages/plugins/vue/src/utils.ts)).

### Returning a response instead of data

If the server block (or an action) returns a `Response`, a `JsonResponseData`,
or a `BunFile`, that is served directly and no component is rendered. This is
how a `.vue` route does a redirect, a CSV download, or a 401.

```vue
<script server>
export async function downloadCsv() {
  return new Response('id,name\n1,Alex', {
    headers: { 'content-type': 'text/csv' },
  })
}
</script>
```

## Server actions

An exported function becomes a client stub that calls back into the route:

```
POST /reports?__vue_action=archive&__vue_file=reports.vue
Content-Type: application/json

{"args": [42]}
```

The stub unwraps the JSON envelope's `data` before resolving, so on the client
the call looks like a local `await archive(42)`.

Dispatch is restricted, and each restriction has a test behind it
([`vue/src/actions.ts`](../../packages/plugins/vue/src/actions.ts),
[`vue-plugin.test.ts`](../../packages/plugins/vue/src/vue-plugin.test.ts)):

- **POST with `Content-Type: application/json` only** — 405 and 415 otherwise.
  This keeps actions outside the set of CORS-simple requests a foreign page can
  issue without a preflight, so a cross-site `<form>` or `<img src>` cannot
  invoke one.
- **Same-origin only** — a mismatched `Origin`, or a `Sec-Fetch-Site` other
  than `same-origin`/`none`, is rejected with 403.
- **Only exported functions are callable.** Data exports are not; `middleware`
  and `default` are explicitly excluded; and `Object.prototype` members
  (`constructor`, `toString`, …) resolve to "not found" rather than to a
  function.
- **`__vue_file` is contained.** It must end in `.vue` and resolve inside the
  serve root; traversal and absolute paths are rejected after resolution, not
  by inspecting the raw string.

Actions still run the block's `middleware` export first, so one guard covers
the page load and every action on it.

## Caching

Compilation is expensive and per-request data is not cacheable, so the two are
separated ([`vue/src/handler.ts`](../../packages/plugins/vue/src/handler.ts)):

- A component **without** a server block, and every **root** script, is
  compiled once and written to `.cache/vue/`, keyed by source mtime.
  The root script reads its data from `globalThis.__vue_server`, which the
  shell sets — so the cached file contains no user data.
- A **subcomponent with** a server block is compiled once into a template
  holding a placeholder token, kept in a 500-entry LRU, and this request's data
  is spliced in on the way out. That response carries
  `Cache-Control: private, no-store`.

Server-block modules are compiled to `.cache/vue/server/<id>_<mtime>.ts`
via a write-then-rename, so a concurrent request can never import a half-written
module, and older compilations of the same source are pruned.

## Escaping

Server data is embedded with `escapeScriptJson`, which escapes `<`, `/` and the
JS line terminators U+2028/U+2029 that raw JSON allows. A value containing
`</script><script>alert(1)</script>` cannot close the tag early. Page titles go
through `escapeHtml`. Both are core helpers re-exported by the plugin — the
framework owns escaping, so core never has to depend on this package
([`vue/src/utils.ts`](../../packages/plugins/vue/src/utils.ts)).

## Known bug: a server block with no `<script setup>` renders blank

If a component has a `<script server>` block that exports anything, but no
`<script setup>` block, the page renders as a blank white screen with a
`ReferenceError: __sfc__ is not defined` in the browser console.

The mechanism: to expose server data and action stubs, the plugin prepends a
plain `<script>` block containing `const { … } = …` declarations
([`vue/src/handler.ts`](../../packages/plugins/vue/src/handler.ts)).
That block has no `export default`. `assembleComponent` creates the component
object by *rewriting* `export default` into `const __sfc__ = `
([`vue/src/compile.ts`](../../packages/plugins/vue/src/compile.ts)) — with
nothing to rewrite, `__sfc__` is never declared, and the very next line assigns
`__sfc__.render`.

Workaround: add a `<script setup>` block, even an empty one. A component whose
server block exports nothing is unaffected, because no script is injected.

## Limitations

- **No SSR.** The shell ships an empty `#app`; first paint waits for the module
  and the Vue runtime. Server data is inlined into the HTML, so there is no
  second round trip for data, but there is no server-rendered markup.
- **A page cannot have both a plain `<script>` and a server block that exports
  anything** — the injected block would be a second plain `<script>`, which the
  SFC parser rejects as a duplicate. Use `<script setup>`.
- Template interpolations are wrapped in a `$fmt()` call, resolved from
  `globalThis.$fmt` at runtime and falling back to identity if the application
  does not define one.
