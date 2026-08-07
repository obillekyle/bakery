/**
 * The app `bun create bakery` writes, as data.
 *
 * Separated from the I/O in `index.ts` so the tests can assert on what gets
 * written without a filesystem, and so the one interesting invariant is
 * checkable: **every `@bakery/*` specifier below resolves through an
 * *enumerated* export, never the `"./*"` wildcard.** That wildcard is a
 * deprecation ramp with one release to live (MONOREPO.md), so a template that
 * leaned on it would generate apps that break on its removal — and it would
 * break them silently, because the wildcard resolves fine today.
 *
 * Derived from `apps/starter`, which is the honest reference: written against
 * public entry points only and booted in CI. The differences are the ones that
 * have to differ — real dependency ranges instead of `workspace:*`, the
 * `bakery` bin instead of a relative path into the repo, and a `.gitignore`.
 */

/** A file to write, relative to the target directory. */
export type TemplateFile = {
  path: string
  contents: string
}

/**
 * The version range the generated `package.json` asks for.
 *
 * Derived from this package's own version rather than written out, because the
 * scaffolder is published in lockstep with the framework: `create-bakery@4.1.0`
 * scaffolding `^4.0.0` is the drift this avoids. Caret, so a generated app
 * picks up patches without regenerating.
 */
export function dependencyRange(ownVersion: string): string {
  return `^${ownVersion}`
}

/**
 * A valid npm package name, scoped or not.
 *
 * Stricter than npm on the parts that are worth being strict about — no
 * uppercase, no leading dot or dash — because the generated `name` field is
 * the only place this lands, and a name npm would reject surfaces as a
 * confusing `bun install` failure several steps after the mistake.
 *
 * Scopes are accepted, and are reachable only through `--name`. The positional
 * argument is a *directory path*, so `bun create bakery @co/app` means a nested
 * directory whose basename is `app` — that is what a path argument means, and
 * quietly treating it as a scoped package name instead would be a guess.
 */
export function isValidAppName(name: string): boolean {
  const SEGMENT = '[a-z0-9][a-z0-9._-]*'
  return (
    new RegExp(`^(?:@${SEGMENT}/)?${SEGMENT}$`).test(name) && name.length <= 214
  )
}

const SERVER_CONFIG = `import { defineConfig } from '@bakery/core'

export default defineConfig({
  root: 'src',
  port: 3000,
})
`

const INDEX_PAGE = `export default function Home() {
  return (
    <html lang="en">
      <head>
        <title>{{name}}</title>
      </head>
      <body>
        <h1>{{name}}</h1>
        <p>Edit <code>src/index.tsx</code> and save — the page reloads itself.</p>
        <p id="count">loading…</p>
        <script src="/script.js" type="module"></script>
      </body>
    </html>
  )
}
`

const API_ROUTE = `import { defineRoute, response } from '@bakery/core'
import DB from '@bakery/orm'

// The type parameter declares the body's shape: body.title / body.slug /
// body.body are strings below, while undeclared keys stay reachable. It states
// the contract — it does not validate it. The body is still client input.
export default defineRoute<{ title: string; slug: string; body: string }>(
  async (req, body) => {
    if (req.method === 'POST') {
      await DB.Insert.into('posts')
        .values({
          authorId: 1,
          title: body.title,
          slug: body.slug,
          body: body.body,
        })
        .run()
      return response.json.success('created')
    }

    const posts = await DB.from('posts').selectAll('posts').array()
    return response.json.success('ok', posts)
  },
)
`

const CLIENT_SCRIPT = `const res = await fetch('/api/notes')
const json = await res.json()
const el = document.getElementById('count')
if (el) el.textContent = \`\${json.data?.length ?? 0} posts\`
`

const ORM_SCHEMA = `import { dateNow, primary, table, value } from '@bakery/orm'

export const users = table('users', {
  id: primary(),
  username: value('string', null),
  email: value('string', null, true),
  createdAt: value('integer', dateNow),
})

export const posts = table('posts', {
  id: primary(),
  authorId: value('integer', null),
  title: value('string', null),
  slug: value('string', null),
  body: value('string', ''),
  published: value('integer', 0),
  createdAt: value('integer', dateNow),
})
`

const ORM_INDEXES = `import { index, unique } from '@bakery/orm'
import { posts, users } from './schema'

export const usernameUniq = unique(users.username)
export const slugUniq = unique(posts.slug)
export const postsByAuthor = index(posts.authorId)
`

/**
 * The `declare module` block is the whole point of this file: it is what makes
 * the ORM typed. Without it everything still runs and typechecks, the columns
 * are just permissive `any` — which is a quiet enough failure that it is worth
 * generating rather than documenting.
 */
const ORM_INDEX = `import type { InferOptionals, InferSchema, InferViews } from '@bakery/orm'
import * as model from './schema'

export * from './schema'
export * from './indexes'

declare module '@bakery/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: InferSchema<typeof model>
      DBOptionals: InferOptionals<typeof model>
      Views: InferViews<typeof model>
    }
  }
}
`

/**
 * Schema sync as a script rather than a package script pointing into
 * `node_modules`.
 *
 * `bakery --sync` is not this: it syncs and then *boots the server*, which is
 * the wrong shape for a `db:sync` you run in a deploy step. The CLI's own
 * standalone path is `import.meta.main` inside `@bakery/orm/sync`, so this
 * reproduces exactly what that guard does, through the enumerated export.
 */
const DB_SYNC_SCRIPT = `import { SyncService } from '@bakery/orm/sync'

await SyncService.run()
process.exit(0)
`

const GITIGNORE = `node_modules

# Bakery's two runtime directories. \`.cache\` is disposable — the framework
# deletes it wholesale on every version bump and dev<->prod switch. \`bakery/\`
# holds server.db and backups/, so it is not tracked either, but do not delete
# it: nothing regenerates what is in there.
.cache
bakery/
`

const README = `# {{name}}

Built with [Bakery](https://github.com/obillekyle/bun-server).

\`\`\`bash
bun install
bun run db:sync   # create the tables in orm/schema.ts
bun run dev
\`\`\`

Then open http://localhost:3000.

## Layout

| Path | What it is |
| --- | --- |
| \`src/\` | Served. Every file is a route — \`src/index.tsx\` is \`/\`, \`src/api/notes.ts\` is \`/api/notes\`. |
| \`orm/schema.ts\` | Table definitions. Run \`bun run db:sync\` after editing. |
| \`orm/index.ts\` | Registers the schema with the ORM's types. Without its \`declare module\` block the ORM still works, untyped. |
| \`server.config.ts\` | Port, root directory, plugins. |

\`bun run start\` serves in production mode; add \`--threads N\` to fork a cluster.
`

/**
 * The three JSX options are repeated here on purpose, and removing them breaks
 * every page in the generated app.
 *
 * `@bakery/core/tsconfig.app.json` already sets them, and `tsc` picks them up
 * from there — but **Bun's runtime does not follow `extends` into a package
 * specifier**, only a relative path. So at runtime the app is transpiled with
 * Bun's default automatic JSX runtime instead of Bakery's classic
 * `createElement`, and every `.tsx` route fails with `Cannot find module
 * 'react/jsx-dev-runtime'`. Typecheck stays clean throughout, which is what
 * makes it nasty.
 *
 * `extends` still carries everything else, and is what `tsc` reads.
 */
const TSCONFIG = `{
  "$comment": "The three jsx* options are also set by @bakery/core/tsconfig.app.json, and tsc reads them from there — but Bun's runtime does not follow 'extends' into a package specifier, only a relative path. Without them here, every .tsx page fails at runtime with \\"Cannot find module 'react/jsx-dev-runtime'\\" while typecheck stays clean. Keep them.",
  "extends": "@bakery/core/tsconfig.app.json",
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "createElement",
    "jsxFragmentFactory": "Fragment"
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "orm/**/*.ts",
    "scripts/**/*.ts",
    "server.config.ts"
  ]
}
`

/**
 * Build the file list for an app named `name`.
 *
 * `range` is threaded in rather than read from disk so this stays pure — the
 * caller resolves it from the running package's own version.
 */
export function templateFiles(name: string, range: string): TemplateFile[] {
  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'bakery --dev',
      start: 'bakery',
      'db:sync': 'bun run scripts/db-sync.ts',
    },
    dependencies: {
      '@bakery/cli': range,
      '@bakery/core': range,
      '@bakery/orm': range,
    },
  }

  return [
    { path: 'package.json', contents: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'tsconfig.json', contents: TSCONFIG },
    { path: '.gitignore', contents: GITIGNORE },
    { path: 'README.md', contents: README.replaceAll('{{name}}', name) },
    { path: 'server.config.ts', contents: SERVER_CONFIG },
    { path: 'scripts/db-sync.ts', contents: DB_SYNC_SCRIPT },
    { path: 'orm/schema.ts', contents: ORM_SCHEMA },
    { path: 'orm/indexes.ts', contents: ORM_INDEXES },
    { path: 'orm/index.ts', contents: ORM_INDEX },
    { path: 'src/index.tsx', contents: INDEX_PAGE.replaceAll('{{name}}', name) },
    { path: 'src/api/notes.ts', contents: API_ROUTE },
    { path: 'src/script.ts', contents: CLIENT_SCRIPT },
  ]
}
