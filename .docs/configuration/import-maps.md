# Import Maps & TSConfig Sync

Bakery supports browser-native [Import Maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) to alias module specifiers in client-side scripts. It automatically synchronizes these aliases into your TypeScript configuration files so that both the browser runtime and your editor's language server agree on module resolution.

---

## What Are Import Maps?

An import map is a JSON structure that instructs the browser how to resolve bare module specifiers. For example:

```html
<script type="importmap">
{
  "imports": {
    "@components": "/src/components/index.js",
    "@utils": "/src/lib/utils.js"
  }
}
</script>
```

After this, any `<script type="module">` can write:

```javascript
import { Button } from '@components'
import { formatDate } from '@utils'
```

Bakery injects the import map into every HTML response automatically based on your `importMap` configuration.

---

## Configuring Import Maps

Define your aliases in `server.config.ts`:

```typescript
import { defineConfig } from '@server/core'

export default defineConfig({
  root: './src',

  importMap: {
    // Alias → Path (relative to project root OR serve root)
    '@components': 'src/components',       // relative to project root
    '@utils': 'src/lib/utils.ts',          // single file alias
    '@icons/': 'src/assets/icons/',        // directory alias (trailing /)
    '@lib': './src/lib',                   // explicit relative
  },
})
```

### Path Resolution Rules

Bakery uses the following logic to resolve import map values to absolute paths, then converts them to paths relative to the project root for TSConfig injection:

| Value Pattern | Resolved Relative To |
|--------------|---------------------|
| `.server/...` or `./.server/...` | Project root (`Bakery.root`) |
| `api/...` or `./api/...` | Project root |
| `node_modules/...` | Project root |
| All other paths | Serve root (`Bakery.serveRoot`, i.e., `root` config) |
| `http://` or `https://` URLs | Skipped (browser-only, no TSConfig entry generated) |

### Directory Aliases

A trailing `/` in the key signals a directory alias. The corresponding TSConfig path will be `key/*` → `value/*`:

```typescript
importMap: {
  '@icons/': 'src/assets/icons/',
  // TSConfig: "@icons/*": ["./src/assets/icons/*"]
}
```

---

## Built-in Alias

The following alias is always present and cannot be removed:

```typescript
'@client/utils': '.server/client/utils'
```

This exposes Bakery's browser-side utility functions (DOM helpers, fetch wrappers, etc.) to your client scripts under a stable import path.

---

## TSConfig Auto-Sync

On every startup, Bakery runs `syncTSConfigPaths()` which:

1. Reads your `importMap` configuration.
2. Converts each entry into a TypeScript path alias.
3. Writes the resulting `paths` into both `tsconfig.app.json` and `tsconfig.json`.
4. Logs `TSConfig paths synced` if any file was changed.

This process is **idempotent** — if the paths are already correct, no files are written.

### Example Output

Given:

```typescript
importMap: {
  '@components': 'src/components',
  '@utils': 'src/lib/utils.ts',
  '@client/utils': '.server/client/utils',
}
```

Bakery writes to `tsconfig.app.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@components": ["./src/components"],
      "@utils": ["./src/lib/utils.ts"],
      "@client/utils": ["./.server/client/utils"]
    }
  }
}
```

> **Note:** `baseUrl` is removed from both tsconfig files during sync to avoid path resolution conflicts.

---

## Using Aliased Imports

### In Client-Side TypeScript (`src/`)

```typescript
// src/script/app.ts
import { formatDate } from '@utils'
import { Button } from '@components'
```

The browser resolves `@utils` via the injected import map. TypeScript resolves it via the synced `tsconfig.app.json` paths.

### In Server-Side Code (`.server/`, `api/`)

Import map aliases do **not** apply to server-side code. Use the `@server/*` and `@database/*` aliases defined in `tsconfig.server.json` instead.

---

## HTTP / CDN Imports (Browser-Only)

You can include CDN URLs in your import map for browser use. These are passed through to the import map without being added to TSConfig:

```typescript
importMap: {
  'lodash-es': 'https://esm.sh/lodash-es',
  'vue': 'https://esm.sh/vue@3',
}
```

The browser will fetch these from the CDN. Your editor will not have type information for them unless you install the types separately.

---

## Troubleshooting

### Editor not recognizing aliases

Restart your TypeScript language server after the first `bun run dev` — Bakery modifies `tsconfig.app.json` at startup, and some editors need a restart to pick up the change.

### `TSConfig sync error` in logs

Check that `tsconfig.app.json` and `tsconfig.json` are valid JSON (no trailing commas, no comments in `tsconfig.app.json`). Bakery strips comments from `tsconfig.json` before parsing, but `tsconfig.app.json` must be valid JSON.

---

*[← Environment Variables](./environment-variables.md) · [Routing System →](../features/routing.md)*

*[← Back to README](../../README.md)*
