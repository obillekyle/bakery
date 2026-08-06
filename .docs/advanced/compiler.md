# Compiler & Virtual Assets

Bakery leverages Bun's native transpiler (`Bun.Transpiler`) to serve TypeScript, process imports, and inject virtual modules on-the-fly. This eliminates the need for an external client-side bundler (like Vite or Webpack) during development and lightweight production.

---

## TS transpilation (`.ts` files)

When the browser requests a `.ts` file from your `root` directory, the `TSHandler` intercepts the request:

1. It reads the raw TypeScript source code.
2. It runs `Bun.Transpiler.transformSync()` to strip types and convert modern TS to browser-compatible JS.
3. It replaces `import.meta.env.*` flags with boolean literals (`true`/`false`), allowing dead-code elimination.
4. It caches the resulting JavaScript in a `TieredCache` mapped to the file's ETag.
5. It serves the file with `Content-Type: text/javascript`.

In production (`bun run serve`), the transpiler is also instructed to **minify** the output (whitespace removal and identifier mangling).

### Import Rewriting

During transpilation, Bakery rewrites certain import statements to ensure the browser can resolve them:

```typescript
// Source:
import { html } from 'lit-html'
import data from './data.json'
import './styles.css'

// Transpiled for browser:
import { html } from '/_nm/lit-html/lit-html.js'  // Node modules proxy
import data from '/_virtual/src/data.json.js'    // Virtual JSON module
import '/_virtual/src/styles.css.js'             // Virtual CSS module
```

---

## Virtual Modules (`/_virtual/`)

Browsers only understand JavaScript natively. When you import a `.css` or `.json` file in a browser script, it would normally throw a MIME type error.

Bakery solves this by rewriting the import to point to `/_virtual/*` and having the `VirtualAssetHandler` generate a JavaScript wrapper on-the-fly.

### JSON Virtual Imports

```typescript
import data from './config.json'
```

Is rewritten to request `/_virtual/config.json.js`. The server reads `config.json` and returns:

```javascript
// /_virtual/config.json.js
export default {
  "key": "value"
};
```

This allows seamless JSON imports in the browser.

### CSS Virtual Imports

```typescript
import './component.css'
```

Is rewritten to request `/_virtual/component.css.js`. The server reads `component.css` and returns a script that automatically injects the CSS into the document `<head>` when executed:

```javascript
// /_virtual/component.css.js
const style = document.createElement('style');
style.textContent = ".my-class { color: red; }";
document.head.appendChild(style);
```

This ensures styles imported by JavaScript components (like Web Components) are applied automatically.

---

## Client Globals (`/_client/`)

Bakery injects internal utility scripts into HTML responses via the `VirtualAssetHandler`.

### `/_client/utils.js`

This file is automatically mapped to `@client/utils` via the import map. It provides DOM helpers and the `Bakery` global object:

```typescript
import { $, $$, Bakery } from '@client/utils'

// Query selector helpers
const btn = $('#submit-btn')
const inputs = $$('input')

// Force reload connected browsers
Bakery.forceReload()
```

### `/_client/livereload.js`

Injected only in development mode. It establishes the WebSocket connection back to the server and handles the hot-swap and smart DOM diffing logic.

---

*[← Cache System](./cache.md) · [CLI Reference →](../reference/cli.md)*

*[← Back to README](../../README.md)*
