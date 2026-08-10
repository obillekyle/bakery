/**
 * The app `bun create bakery` writes, as data.
 *
 * Separated from the I/O in `index.ts` so the tests can assert on what gets
 * written without a filesystem, and so the one interesting invariant is
 * checkable: **every `@bakery-framework/*` specifier below resolves through an
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

/** The plugins `--plugins` accepts, in the order they are registered. */
export const PLUGIN_IDS = ['vue', 'analytics', 'dashboard'] as const
export type PluginId = (typeof PLUGIN_IDS)[number]

export type TemplateOptions = {
  /** Generate `orm/` and depend on `@bakery-framework/orm`. */
  orm: boolean
  plugins: PluginId[]
}

/**
 * What each plugin costs a generated app.
 *
 * `peers` matters and is easy to miss: `@bakery-framework/plugin-vue` declares `vue` and
 * `@vue/compiler-sfc` as **peer** dependencies, so scaffolding the plugin
 * without them produces an app that installs cleanly and then fails the first
 * time it compiles an SFC. They go into the generated `dependencies`, because a
 * scaffolded app is an application — it should pin what it needs rather than
 * inherit an unmet peer warning.
 */
const PLUGINS: Record<
  PluginId,
  { pkg: string; import: string; call: string; peers?: Record<string, string> }
> = {
  vue: {
    pkg: '@bakery-framework/plugin-vue',
    import: 'vuePlugin',
    call: 'vuePlugin()',
    peers: { vue: '^3.5.0', '@vue/compiler-sfc': '^3.5.0' },
  },
  analytics: {
    pkg: '@bakery-framework/plugin-analytics',
    import: 'analyticsPlugin',
    call: 'analyticsPlugin()',
  },
  dashboard: {
    pkg: '@bakery-framework/plugin-dashboard',
    import: 'dashboardPlugin',
    // Deliberately no `authorize`. Omitted, the dashboard limits itself to
    // loopback in development and denies in production, so a scaffolded app is
    // never born with an open console. `apps/example` passes `() => true`
    // because it is a local demo; a generated app is not.
    call: 'dashboardPlugin()',
  },
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

function serverConfig(plugins: PluginId[]): string {
  const imports = plugins
    .map(id => `import ${PLUGINS[id].import} from '${PLUGINS[id].pkg}'\n`)
    .join('')

  if (!plugins.length) {
    return `import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  port: 3000,
})
`
  }

  const calls = plugins.map(id => `    ${PLUGINS[id].call},\n`).join('')
  const dashboardNote = plugins.includes('dashboard')
    ? `  // The dashboard authenticates nobody itself — the app does, because it is\n` +
      `  // the thing that knows who its users are. With no \`authorize\`, access is\n` +
      `  // loopback-only in development and denied in production:\n` +
      `  //\n` +
      `  //   dashboardPlugin({ authorize: req => req.session.get('role') === 'admin' })\n`
    : ''

  return `import { defineConfig } from '@bakery-framework/core'
${imports}
export default defineConfig({
  root: 'src',
  port: 3000,
${dashboardNote}  plugins: [
${calls}  ],
})
`
}

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

const API_ROUTE = `import { defineRoute, response } from '@bakery-framework/core'
import DB from '@bakery-framework/orm'

// The type parameter declares the body's shape: body.title / body.slug /
// body.body are strings below, while undeclared keys stay reachable.
//
// It states the contract; it does not enforce it. To enforce it, pass a
// validator and the handler only runs on a body that satisfies it:
//
//   export default defineRoute({ body: mySchema }, async (req, body) => …)
//
// The body option takes a Standard Schema (zod, valibot, arktype — Bakery
// bundles none of them), or a plain function returning the parsed value or
// throwing. A rejection answers 400 through the same JSON envelope as
// everything else.
// posts.authorId is a foreign key into users, so a post cannot be inserted
// before its author exists — the database refuses a dangling id, which is the
// entire point of the constraint. A real app takes the author from the session;
// this creates one on demand so the route works on a freshly synced database.
async function authorId(): Promise<number> {
  const [existing] = await DB.from('users').selectAll('users').limit(1).array()
  if (existing) return Number(existing.id)

  const created = await DB.Insert.into('users')
    .values({ username: 'demo', email: 'demo@example.com' })
    .run()
  return Number(created.lastInsertRowid)
}

export default defineRoute<{ title: string; slug: string; body: string }>(
  async (req, body) => {
    if (req.method === 'POST') {
      await DB.Insert.into('posts')
        .values({
          authorId: await authorId(),
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

/**
 * The same route without a database.
 *
 * Kept to the same shape — `defineRoute`, a typed body, one JSON envelope, and
 * `data` as an array — so the client script below is identical either way and
 * the two templates do not drift into demonstrating different things.
 */
const API_ROUTE_NO_ORM = `import { defineRoute, response } from '@bakery-framework/core'

// In memory, and therefore per process: a cluster (\`--threads N\`) gives each
// worker its own copy. That is the point at which you want the ORM — scaffold
// with it, or add @bakery-framework/orm later.
const posts: { title: string }[] = []

// The type parameter declares the body's shape. It states the contract; to
// enforce it, pass a validator: defineRoute({ body: schema }, handler).
export default defineRoute<{ title: string }>(async (req, body) => {
  if (req.method === 'POST') {
    posts.push({ title: body.title })
    return response.json.success('created')
  }

  return response.json.success('ok', posts)
})
`

const CLIENT_SCRIPT = `const res = await fetch('/api/notes')
const json = await res.json()
const el = document.getElementById('count')
if (el) el.textContent = \`\${json.data?.length ?? 0} posts\`
`

const ORM_SCHEMA = `import { Field, table } from '@bakery-framework/orm'

export const users = table('users', {
  id: Field.Primary(),
  username: Field.Varchar(64, null),
  email: Field.Varchar(255, null),
  createdAt: Field.Date.now(),
})

export const posts = table('posts', {
  // The reference lives on the column it constrains, and is always an integer
  // because Field.Primary() always is.
  id: Field.Primary(),
  authorId: Field.Foreign(users.id, { onDelete: 'CASCADE' }),
  title: Field.Varchar(255, null),
  slug: Field.Varchar(255, null),
  // Sized because it has a default: MySQL refuses a literal DEFAULT on TEXT.
  body: Field.Varchar(8192, ''),
  published: Field.Int(0),
  createdAt: Field.Date.now(),
})
`

const ORM_INDEXES = `import { Field } from '@bakery-framework/orm'
import { posts, users } from './tables'

export const usernameUniq = Field.Unique(users.username)
export const slugUniq = Field.Unique(posts.slug)
export const postsByAuthor = Field.Index(posts.authorId)
`

/**
 * The `declare module` block is the whole point of this file: it is what makes
 * the ORM typed. Without it everything still runs and typechecks, the columns
 * are just permissive `any` — which is a quiet enough failure that it is worth
 * generating rather than documenting.
 */

const ORM_VIEWS = `import { view } from '@bakery-framework/orm'
import { posts } from './tables'

// A view is a stored SELECT the database treats as a read-only table. Borrowing
// the source table's columns rather than restating them keeps the two in step.
export const publishedPosts = view(
  'published_posts',
  posts,
  'SELECT * FROM posts WHERE published = 1',
)
`

const ORM_INDEX = `import type { InferOptionals, InferSchema, InferViews } from '@bakery-framework/orm'
import * as tables from './tables'
import * as views from './views'

export * from './tables'
export * from './views'
export * from './indexes'

// Tables *and* views: InferSchema reads both, and InferViews reads the views
// specifically -- that is what stops DB.Insert.into() targeting one.
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
`

/**
 * Schema sync as a script rather than a package script pointing into
 * `node_modules`.
 *
 * `bakery --sync` is not this: it syncs and then *boots the server*, which is
 * the wrong shape for a `db:sync` you run in a deploy step. The CLI's own
 * standalone path is `import.meta.main` inside `@bakery-framework/orm/sync`, so this
 * reproduces exactly what that guard does, through the enumerated export.
 */
const DB_SYNC_SCRIPT = `import { SyncService } from '@bakery-framework/orm/sync'

await SyncService.run()
process.exit(0)
`

function gitignore(orm: boolean): string {
  // `bakery/` only exists once something opens a database, so an app scaffolded
  // without the ORM does not get a rule for a directory it will never have.
  const data = orm
    ? '\n# `bakery/` holds server.db and backups/. Not tracked either, but do not\n' +
      '# delete it: nothing regenerates what is in there.\nbakery/\n'
    : ''

  return `node_modules

# Disposable — the framework deletes it wholesale on every version bump and
# dev<->prod switch.
.cache
${data}`
}

function readme(name: string, orm: boolean, plugins: PluginId[]): string {
  const sync = orm
    ? 'bun run db:sync   # create the tables in orm/tables.ts\n'
    : ''

  const ormRows = orm
    ? '| `orm/tables.ts` | Table definitions. Run `bun run db:sync` after editing. |\n' +
      '| `orm/views.ts` | View definitions — stored SELECTs, read-only. |\n' +
      "| `orm/index.ts` | Registers the schema with the ORM's types. Without its `declare module` block the ORM still works, untyped. |\n"
    : ''

  const pluginSection = plugins.length
    ? `\n## Plugins\n\nRegistered in \`server.config.ts\`:\n\n` +
      plugins.map(id => `- \`${PLUGINS[id].pkg}\``).join('\n') +
      (plugins.includes('dashboard')
        ? '\n\nThe dashboard is loopback-only in development and denied in production ' +
          'until you give it an `authorize` predicate.'
        : '') +
      (plugins.includes('vue')
        ? '\n\n`vue` and `@vue/compiler-sfc` are direct dependencies rather than ' +
          'unmet peers, so `.vue` pages compile straight after install.'
        : '') +
      '\n'
    : ''

  const noOrm = orm
    ? ''
    : '\nScaffolded without the ORM. `src/api/notes.ts` keeps its posts in memory, ' +
      'which is per process — add `@bakery-framework/orm` when you want them to outlive a ' +
      'restart or survive `--threads`.\n'

  return `# ${name}

Built with [Bakery](https://github.com/obillekyle/bakery).

\`\`\`bash
bun install
${sync}bun run dev
\`\`\`

Then open http://localhost:3000.
${noOrm}
## Layout

| Path | What it is |
| --- | --- |
| \`src/\` | Served. Every file is a route — \`src/index.tsx\` is \`/\`, \`src/api/notes.ts\` is \`/api/notes\`. |
${ormRows}| \`server.config.ts\` | Port, root directory, plugins. |
${pluginSection}
\`bun run start\` serves in production mode; add \`--threads N\` to fork a cluster.
`
}

/**
 * The three JSX options are repeated here on purpose, and removing them breaks
 * every page in the generated app.
 *
 * `@bakery-framework/core/tsconfig.server.json` already sets them, and `tsc` picks them up
 * from there — but **Bun's runtime does not follow `extends` into a package
 * specifier**, only a relative path. So at runtime the app is transpiled with
 * Bun's default automatic JSX runtime instead of Bakery's classic
 * `createElement`, and every `.tsx` route fails with `Cannot find module
 * 'react/jsx-dev-runtime'`. Typecheck stays clean throughout, which is what
 * makes it nasty.
 *
 * `extends` still carries everything else, and is what `tsc` reads.
 */
function tsconfig(orm: boolean): string {
  const include = [
    '"src/**/*.ts"',
    '"src/**/*.tsx"',
    ...(orm ? ['"orm/**/*.ts"', '"scripts/**/*.ts"'] : []),
    '"server.config.ts"',
  ]
    .map(entry => `    ${entry}`)
    .join(',\n')

  return `{
  "$comment": "The three jsx* options are also set by @bakery-framework/core/tsconfig.server.json, and tsc reads them from there — but Bun's runtime does not follow 'extends' into a package specifier, only a relative path. Without them here, every .tsx page fails at runtime with \\"Cannot find module 'react/jsx-dev-runtime'\\" while typecheck stays clean. Keep them.",
  "extends": "@bakery-framework/core/tsconfig.server.json",
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "createElement",
    "jsxFragmentFactory": "Fragment"
  },
  "include": [
${include}
  ]
}
`
}

/**
 * Build the file list for an app named `name`.
 *
 * `range` is threaded in rather than read from disk so this stays pure — the
 * caller resolves it from the running package's own version.
 */
export function templateFiles(
  name: string,
  range: string,
  options: TemplateOptions = { orm: true, plugins: [] },
): TemplateFile[] {
  const { orm, plugins } = options

  const dependencies: Record<string, string> = {
    '@bakery-framework/cli': range,
    '@bakery-framework/core': range,
  }
  if (orm) dependencies['@bakery-framework/orm'] = range
  for (const id of plugins) {
    dependencies[PLUGINS[id].pkg] = range
    Object.assign(dependencies, PLUGINS[id].peers ?? {})
  }

  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'bakery --dev',
      start: 'bakery',
      typecheck: 'tsc --noEmit',
      ...(orm ? { 'db:sync': 'bun run scripts/db-sync.ts' } : {}),
    },
    // Sorted, because the key order here is otherwise "whichever plugin was
    // listed first", and a generated file that differs run to run is a diff
    // nobody can read.
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
    ),
    // `bun-types` is not optional, and its absence is invisible until you run
    // tsc. `@bakery-framework/core/tsconfig.server.json` sets
    // `"types": ["bun-types"]` — it has to, that is what makes `Bun.*` a type
    // error in browser code — but core declares no dependencies at all, so
    // nothing installs the package the setting names. In this repo it resolves
    // from a *root* devDependency, which is why the gap was invisible from
    // inside the workspace: a generated app typechecked here and died with
    // `TS2688: Cannot find type definition file for 'bun-types'` anywhere else.
    //
    // An app owning its own toolchain is the right shape regardless — the
    // alternative is core taking a dependency, and having none is a property
    // worth more than this convenience.
    devDependencies: {
      'bun-types': '^1.3.14',
      typescript: '^7.0.0',
    },
  }

  const files: TemplateFile[] = [
    { path: 'package.json', contents: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'tsconfig.json', contents: tsconfig(orm) },
    { path: '.gitignore', contents: gitignore(orm) },
    { path: 'README.md', contents: readme(name, orm, plugins) },
    { path: 'server.config.ts', contents: serverConfig(plugins) },
    {
      path: 'src/index.tsx',
      contents: INDEX_PAGE.replaceAll('{{name}}', name),
    },
    { path: 'src/api/notes.ts', contents: orm ? API_ROUTE : API_ROUTE_NO_ORM },
    { path: 'src/script.ts', contents: CLIENT_SCRIPT },
  ]

  if (orm) {
    files.push(
      { path: 'scripts/db-sync.ts', contents: DB_SYNC_SCRIPT },
      { path: 'orm/tables.ts', contents: ORM_SCHEMA },
      { path: 'orm/views.ts', contents: ORM_VIEWS },
      { path: 'orm/indexes.ts', contents: ORM_INDEXES },
      { path: 'orm/index.ts', contents: ORM_INDEX },
    )
  }

  return files
}
