import { readFileSync } from 'node:fs'
import { Bakery } from '../core/bakery'
import { errorMsg, serveLog } from '../logger'
import type { PluginTsProject } from '../plugins/types'
import type { MapOf } from '../types'
import { fs } from '../utils/fs'
import { parseJSONC } from '../utils/jsonc'

// 🚀 Hoisted Regexes
const RE_ROOT_RELATIVE = /^(\.\/)?(\.server|api|node_modules)\//
const RE_HTTP = /^https?:\/\//
const RE_LEADING_SLASHES = /^(\.\/|\/)/
const RE_RELATIVE = /^\.\.?\//
const RE_TRAILING_WILDCARD = /\/?\*?$/
// Drive letters included: `Bakery.config.root` is absolute, and on Windows
// that is `C:/…` rather than a leading slash.
const RE_ABSOLUTE = /^([A-Za-z]:)?[\\/]/

// The application's tsconfig, resolved against its cwd. This used to write into
// a tsconfig *inside the framework*: app-specific paths mutating a shipped
// package file, which is also why running the test suite dirtied the tree.
const APP_CONFIG_PATH = fs.resolve(process.cwd(), 'tsconfig.json')
const APP_DIR = process.cwd()

function buildPaths(): MapOf<string[]> {
  const newPaths: MapOf<string[]> = {}

  for (const [key, val] of Object.entries(Bakery.config.importMap)) {
    if (RE_HTTP.test(val)) continue
    // Values the server maps to a served URL ('/_client/utils.js') are not
    // filesystem paths; turning them into tsconfig paths yields a directory
    // that does not exist. Their type mapping belongs in tsconfig.base.json.
    if (val.startsWith('/')) continue

    const isDir = key.endsWith('/')
    const tsKey = isDir ? `${key.slice(0, -1)}/*` : key

    const absolutePath = RE_ROOT_RELATIVE.test(val)
      ? fs.resolve(Bakery.root, val)
      : fs.resolve(Bakery.serveRoot, val.replace(RE_LEADING_SLASHES, ''))

    const relativePath = fs.relative(APP_DIR, absolutePath)

    let tsVal = (RE_RELATIVE.test(relativePath) ? '' : './') + relativePath
    if (isDir) tsVal = tsVal.replace(RE_TRAILING_WILDCARD, '/*')

    newPaths[tsKey] = [tsVal]
  }

  return newPaths
}

/** Where the generated projects go, and where the root config points. */
const PROJECT_DIR = fs.resolve(APP_DIR, '.cache/tsconfig')

/**
 * The three projects core always generates.
 *
 * The split is the whole point: `server` and `api` carry `bun-types` and
 * `client` does not, so `Bun.*` in a file bound for the browser is a type
 * error rather than a runtime one. Before this existed, one config covered
 * everything and `Bun.hash()` in a client file typechecked clean and failed
 * in the browser.
 *
 * **Between them they claim every app file once**, because the app's root
 * tsconfig claims none: it reaches these projects through
 * `tsconfig.bakery.json` (see {@link syncTSConfigProjects}), and an editor
 * gives a file to the first project that claims it. A file nobody claims
 * falls into an inferred project with default options and no `bun-types`,
 * which is how every `api/` file in a real app reported "Cannot find name
 * 'Bun'". So `server` is defined by what it is not: everything outside the
 * serve root (config, schema, `orm/`, `scripts/`, `tests/`, migrations) plus
 * every `.tsx` page, which is server-rendered. `api` is its own project only
 * because a glob cannot say "`src/**` except `api/`" in either direction.
 *
 * Naming an `exclude` drops TypeScript's default one, so `node_modules` and
 * `.cache` (compiled server modules live there as `.ts`) are named again.
 *
 * Globs are app-relative here and rewritten to be relative to the generated
 * file, which sits two levels down.
 */
export function coreProjects(): PluginTsProject[] {
  const root = Bakery.config.root ?? 'src'

  return [
    {
      name: 'server',
      server: true,
      extends: '@bakery-framework/core/tsconfig.server.json',
      // Repeated rather than inherited: Bun's runtime does not follow
      // `extends` into a package specifier, only a relative path.
      compilerOptions: {
        jsx: 'react',
        jsxFactory: 'createElement',
        jsxFragmentFactory: 'Fragment',
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: [`${root}/**/*.ts`, 'node_modules', '.cache'],
    },
    {
      name: 'api',
      server: true,
      extends: '@bakery-framework/core/tsconfig.server.json',
      include: [`${root}/**/api/**/*.ts`],
    },
    {
      name: 'client',
      extends: '@bakery-framework/core/tsconfig.app.json',
      include: [`${root}/**/*.ts`],
      exclude: [`${root}/**/api/**/*.ts`],
      // The only project that gets `importMap` aliases, because the import map
      // is a browser mechanism. See `importMapPaths` on `PluginTsProject`.
      importMapPaths: true,
    },
  ]
}

/**
 * Turn an app-relative glob into one relative to `.cache/tsconfig/`.
 *
 * Two levels up, and always with a leading `../` so TypeScript reads it as a
 * path rather than resolving it against the project directory.
 */
export function fromProjectDir(pathOrGlob: string): string {
  // **`Bakery.config.root` is absolute**, so globs built from it arrive here as
  // full paths. Prefixing `../../` to one yields
  // `../../C:/WebDAV/.../src/**/*.ts`, which matches nothing, and a project
  // that matches nothing typechecks clean, so the mistake presents as success.
  // That is exactly how the first version of this passed with zero files.
  if (RE_ABSOLUTE.test(pathOrGlob)) {
    const rel = fs.relative(PROJECT_DIR, pathOrGlob).replace(/\\/g, '/')
    return RE_RELATIVE.test(rel) ? rel : `./${rel}`
  }
  return `../../${pathOrGlob.replace(RE_LEADING_SLASHES, '')}`
}

/**
 * Resolve a `files` entry to something TypeScript will actually load.
 *
 * A package specifier is the useful form for a plugin to write (it does not
 * know where it was installed), but `files` is resolved as a path, so
 * `@scope/pkg/x.d.ts` would simply be missing. Resolution failure is not fatal:
 * a plugin whose declaration cannot be found should degrade to "no types" and
 * say so, not stop the dev server from booting.
 */
function resolveFilesEntry(entry: string): string | null {
  if (entry.startsWith('.') || entry.startsWith('/')) {
    return fromProjectDir(entry)
  }
  try {
    const abs = Bun.resolveSync(entry, APP_DIR)
    const rel = fs.relative(PROJECT_DIR, abs).replace(/\\/g, '/')
    return RE_RELATIVE.test(rel) ? rel : `./${rel}`
  } catch {
    return null
  }
}

/**
 * The `files` the extended base config declares, resolved for the generated one.
 *
 * **TypeScript's rule is that a child's `files` *replaces* the parent's, and
 * that rule silently disarmed every project a plugin contributes.**
 * `tsconfig.vue.json` lists core's three ambient declarations: `global.d.ts`,
 * `shared.d.ts`, `types.d.ts`, which is where `Bakery`, `AppConfig`, the JSX
 * namespace and `Request.session` come from. `@bakery-framework/plugin-vue`
 * declares one `files` entry of its own for `vue.d.ts`, and that one entry
 * replaced all three: measured on a real app, the generated `vue` project loaded
 * **zero** of them.
 *
 * It hid because `vue.d.ts` happens to declare `req` and `body` itself, so the
 * globals an SFC reaches for most still resolved. Everything else (`Bakery`,
 * `MapOf`, the JSX namespace) was quietly missing.
 *
 * So the base's list is read and merged rather than inherited. Paths inside it
 * are relative to *that* file, which is the property the whole arrangement rests
 * on and the reason they cannot simply be copied across.
 */
function readBase(extendsSpecifier: string): string[] {
  try {
    const base = Bun.resolveSync(extendsSpecifier, APP_DIR)
    const parsed = parseJSONC(readFileSync(base, 'utf8'))
    const list: string[] = Array.isArray(parsed?.files) ? parsed.files : []
    const baseDir = fs.dirname(base)

    return list.map(entry => {
      const abs = fs.resolve(baseDir, entry)
      const rel = fs.relative(PROJECT_DIR, abs).replace(/\\/g, '/')
      return RE_RELATIVE.test(rel) ? rel : `./${rel}`
    })
  } catch {
    // A base that cannot be read is not fatal: the project still compiles, it
    // just loses the ambients, which is the status quo this repairs, not a
    // regression. Assume client-side, which is the conservative half.
    return []
  }
}

/**
 * The app file carrying `declare module '@bakery-framework/orm/schema-registry'`.
 *
 * Declaration merging only happens if the declaring file is in the program, and
 * it reached exactly one project: `server`, because that is the only one whose
 * `include` covers `orm/**`. Everywhere else `SchemaRegistry` stayed empty,
 * `Registered` resolved to `never`, and every table fell back to
 * `MapOf<MapOf<any>>`: the ORM's documented untyped mode, arrived at by
 * accident. It does not error; it just stops checking.
 *
 * **Server-side projects only.** The client project deliberately does not get
 * it: the ORM is server-only, so a browser file importing `DB` should fail to
 * typecheck rather than be helpfully typed. That is not only a preference:
 * `@bakery-framework/orm` ships TypeScript source that calls `Bun.*`, so pulling
 * it into a config without `bun-types` produces errors from inside the package
 * rather than types for the app. Measured when this was applied to every
 * project: 187 new errors in `client`.
 */
function schemaRegistrationFile(): string | null {
  const configured = Bakery.config.schema
  const candidates = configured
    ? [configured, `${configured}/index.ts`]
    : ['orm/index.ts', 'schema.ts']

  for (const rel of candidates) {
    const abs = fs.resolve(APP_DIR, rel)
    if (fs.isFileSync(abs)) return abs
  }
  return null
}

/** Every project: core's two, plus whatever the loaded plugins contribute. */
function allProjects(): PluginTsProject[] {
  const projects = coreProjects()
  const seen = new Set(projects.map(p => p.name))

  for (const plugin of Bakery.config.plugins ?? []) {
    const project = plugin?.tsconfig?.project
    if (!project) continue

    // A plugin cannot silently replace `server` or `client`, or another
    // plugin's project. Skipping with a log beats a collision that presents as
    // "my types stopped working" three plugins later.
    if (seen.has(project.name)) {
      serveLog.TSCONFIG_PROJECT_CLASH({
        plugin: plugin.name,
        project: project.name,
      })
      continue
    }

    seen.add(project.name)
    projects.push(project)
  }

  return projects
}

/**
 * Write `.cache/tsconfig/*.json` and point the root config at them.
 *
 * The root becomes references-only. Anything a person had in `compilerOptions`
 * there stops applying, which is why the generated projects carry the JSX
 * options rather than relying on the root.
 */
export async function writeProjects(paths: MapOf<string[]>): Promise<string[]> {
  const written: string[] = []
  const found = schemaRegistrationFile()
  const registrationFile = found
    ? (() => {
        const rel = fs.relative(PROJECT_DIR, found).replace(/\\/g, '/')
        return RE_RELATIVE.test(rel) ? rel : `./${rel}`
      })()
    : null

  for (const project of allProjects()) {
    const own = (project.files ?? [])
      .map(entry => {
        const resolved = resolveFilesEntry(entry)
        if (!resolved) {
          serveLog.TSCONFIG_FILE_UNRESOLVED({ entry })
        }
        return resolved
      })
      .filter((f): f is string => f !== null)

    const baseFiles = readBase(project.extends)

    // The schema registration goes to every server-side project, so an SFC's
    // `<script>` gets the app's real tables rather than the `any` fallback. The
    // server project already reaches it through `include: ['orm/**']`; adding it
    // to `files` there is a harmless duplicate and keeps the rule in one place.
    const registration =
      project.server && registrationFile ? [registrationFile] : []

    // The base's own `files` are merged back in whenever this project declares
    // any of its own, because a child's `files` *replaces* the parent's. See
    // `readBase`. Left entirely empty, TypeScript inherits correctly and there
    // is nothing to repair.
    const declared = [...own, ...registration]
    const files = declared.length
      ? [...new Set([...baseFiles, ...declared])]
      : []

    const config: Record<string, unknown> = {
      $comment:
        'GENERATED by Bakery on dev boot. Edits are lost; change the plugin or server.config.ts instead.',
      extends: project.extends,
      compilerOptions: {
        ...(project.compilerOptions ?? {}),
        // Only projects that opt in. `importMap` is served to the browser as
        // `<script type="importmap">`, so its specifiers are resolved there and
        // nowhere else: writing them into the server project made an import
        // that cannot work on the server typecheck as though it could.
        ...(project.importMapPaths && Object.keys(paths).length
          ? { paths: mapPaths(paths) }
          : {}),
      },
    }

    if (files.length) config.files = files
    if (project.include) config.include = project.include.map(fromProjectDir)
    if (project.exclude) config.exclude = project.exclude.map(fromProjectDir)

    const target = fs.resolve(PROJECT_DIR, `${project.name}.json`)
    await Bun.write(target, `${JSON.stringify(config, null, 2)}\n`)
    written.push(project.name)
  }

  return written
}

/** `paths` values are app-relative; the generated files sit two levels down. */
function mapPaths(paths: MapOf<string[]>): MapOf<string[]> {
  const out: MapOf<string[]> = {}
  for (const [key, values] of Object.entries(paths)) {
    out[key] = values.map(fromProjectDir)
  }
  return out
}

/**
 * A `references` entry the generator wrote in a previous release, as opposed
 * to one the developer owns. Ours always pointed into `.cache/tsconfig/`, and
 * nothing else has a reason to: `.cache/` is the disposable runtime directory,
 * and every project inside it is regenerated on boot.
 */
const RE_GENERATED_REF = /^(\.[\\/])?\.cache[\\/]tsconfig[\\/]/

function isGeneratedReference(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const path = (entry as { path?: unknown }).path
  return typeof path === 'string' && RE_GENERATED_REF.test(path)
}

/**
 * The root config with the generator's own `references` removed, or `null`
 * when there is nothing to repair.
 *
 * Until 2026-08-27 `syncTSConfigProjects` *added* those references, wiring the
 * generated projects into the app's project graph. That glue is what broke
 * `tsc -p <app>` for every consumer who had booted once. Measured directly
 * (TypeScript 6.0.3):
 *
 * - `tsc -p` verifies every referenced project whenever the referencing
 *   program has input files of its own: a reference to a non-composite
 *   project is TS6306 and to a `noEmit` one TS6310, **even when the
 *   referenced project's include is disjoint from the root's, and even when
 *   it matches zero files**. No include shape survives.
 * - Each root file a referenced project also claims is redirected to that
 *   project's declaration output, which `noEmit` guarantees was never built:
 *   TS6305, once per overlapping file: `src/**`, `server.config.ts`, every
 *   `.tsx` page.
 *
 * The generated projects extend `noEmit` bases and rely on
 * `allowImportingTsExtensions`, so they are unbuildable by design. Making them
 * `composite` instead would trade the errors above for a `tsc -b` build-order
 * requirement no consumer runs, and TS6305 would still fire for any root file
 * importing into one while unbuilt.
 *
 * **A root that has files of its own tolerates no reference into them,
 * direct or chained.** Routed through a `composite`, `files: []` middle
 * config, TS6306 and TS6310 go away and TS6305 does not: measured on a real
 * app whose root claimed `src/**`, 57 of them. What works is the other
 * direction, a root that claims nothing and reaches the projects through
 * `tsconfig.bakery.json` (see {@link wireRoot}). This strips the direct
 * entries previous releases wrote, which is still a repair worth making.
 *
 * Everything the developer owns is preserved: only entries into
 * `.cache/tsconfig/` are removed, a real project reference (say `../shared`)
 * stays, and the `references` key itself survives unless the generator wrote
 * every entry in it.
 *
 * Pure, and exported, so the repair can be tested without a function that
 * writes to `process.cwd()`. The property that matters is negative (*no key
 * the developer wrote is lost*), which a shape assertion on the source cannot
 * check.
 */
export function stripGeneratedReferences(
  current: Record<string, unknown>,
): Record<string, unknown> | null {
  const refs = current.references
  if (!Array.isArray(refs)) return null

  const kept = refs.filter(entry => !isGeneratedReference(entry))
  if (kept.length === refs.length) return null

  const repaired = { ...current }
  if (kept.length) repaired.references = kept
  else delete repaired.references
  return repaired
}

/** The generated file the root config references, and how it is spelled there. */
const CHAIN_FILE = 'tsconfig.bakery.json'
const CHAIN_PATH = fs.resolve(APP_DIR, CHAIN_FILE)
const CHAIN_REF = `./${CHAIN_FILE}`

/**
 * `tsconfig.bakery.json`: every generated project, listed for an editor.
 *
 * **The middle layer is what makes the chain legal.** The root references
 * this file, and this file references `.cache/tsconfig/*`. A root referencing
 * those projects directly gets TS6306 and TS6310 for pointing at
 * non-composite, `noEmit` projects. A `composite` config with `files: []` in
 * between is a valid target, and tsserver follows references through it.
 * Measured on a real app with TypeScript 5.9.3: every `api/` file moved from
 * an inferred project with no `bun-types` to the server-side project, and
 * every other `.ts` file to `client`.
 *
 * The server owns this file. A plugin contributes a project through
 * `tsconfig.project` and the generator lists it here, so a plugin never writes
 * it, and a project that failed to write is not listed.
 */
export function chainConfig(names: string[]): Record<string, unknown> {
  return {
    $comment:
      'GENERATED by Bakery on dev boot and by `bakery --types`. Edits are lost. tsconfig.json references this file, and it references each project in .cache/tsconfig/, which is how an editor gives a file its scope.',
    compilerOptions: { composite: true },
    files: [],
    references: names.map(name => ({ path: `./.cache/tsconfig/${name}.json` })),
  }
}

/**
 * Write the chain file when its content changes, and say whether it did.
 *
 * A boot that rewrites an unchanged file dirties git every time and trains
 * people to ignore the diff. The answer also decides when the advice for a
 * root that claims files is worth giving (see {@link syncTSConfigProjects}).
 */
async function writeChain(names: string[]): Promise<boolean> {
  const next = `${JSON.stringify(chainConfig(names), null, 2)}\n`
  const current = fs.exists(CHAIN_PATH)
    ? await Bun.file(CHAIN_PATH).text()
    : null
  if (current === next) return false
  await Bun.write(CHAIN_PATH, next)
  return true
}

/** Whether a root config already references the chain file, however spelled. */
export function referencesChain(root: Record<string, unknown>): boolean {
  const refs = root.references
  if (!Array.isArray(refs)) return false
  return refs.some(entry => {
    const path = (entry as { path?: unknown } | null)?.path
    return (
      typeof path === 'string' &&
      path.replace(/\\/g, '/').replace(RE_LEADING_SLASHES, '') === CHAIN_FILE
    )
  })
}

/**
 * The config a root `extends`, read one level deep, or `null`.
 *
 * Only for {@link claimsAppFiles}: a root with no `files` or `include` of its
 * own inherits the base's, and core's server config lists the three ambient
 * declarations, which is what keeps such a root from claiming its whole
 * directory.
 */
function baseConfigOf(
  root: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof root.extends !== 'string') return null
  try {
    const base = Bun.resolveSync(root.extends, APP_DIR)
    return parseJSONC(readFileSync(base, 'utf8'))
  } catch {
    // Unreadable reads as "no base", which `claimsAppFiles` takes as
    // TypeScript's default of claiming everything: the root is then left
    // unwired, which is the direction that cannot break `tsc -p`.
    return null
  }
}

/**
 * Whether a root config claims app files for itself.
 *
 * **A root that does cannot be wired to the chain.** Each file it shares with
 * a generated project is redirected to that project's never-built output, and
 * `tsc -p` fails with TS6305 once per file: 57 on the app this was measured
 * on. Declaration files are not redirected, so a root claiming only ambient
 * `.d.ts` files, which is what it inherits from core's server config, claims
 * nothing that matters.
 *
 * TypeScript's rules, in order: the root's own `include` and `files` win over
 * the base's; `files` without `include` claims only those files; and neither,
 * anywhere, claims every file under the directory.
 */
export function claimsAppFiles(
  root: Record<string, unknown>,
  base: Record<string, unknown> | null,
): boolean {
  const pick = (key: 'include' | 'files') =>
    key in root ? root[key] : base?.[key]
  const include = pick('include')
  const files = pick('files')

  if (Array.isArray(include) && include.length > 0) return true
  if (
    Array.isArray(files) &&
    files.some(f => typeof f === 'string' && !f.endsWith('.d.ts'))
  ) {
    return true
  }
  return include === undefined && files === undefined
}

/**
 * Add the chain reference to a root with no `references` key, as text.
 *
 * **Textual, so the developer's comments survive.** `tsconfig.json` is JSONC
 * and theirs, and a parse-and-stringify rewrite drops every comment in it.
 * This finds the last member of the top-level object, skipping strings and
 * comments, and adds one member after it, with a comma unless one is already
 * there. `null` when the text has no top-level object to extend.
 */
export function insertChainReference(text: string): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let depth = 0
  let inString = false
  let escaped = false
  let last = -1
  let close = -1

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      last = i
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === '"') {
      inString = true
      last = i
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0 && c === '}') {
        close = i
        break
      }
    }
    last = i
  }

  if (close === -1 || last === -1) return null

  const comma = text[last] === '{' || text[last] === ',' ? '' : ','
  const rest = text.slice(last + 1)
  const gap = rest.startsWith('\n') || rest.startsWith('\r\n') ? '' : eol
  return `${text.slice(0, last + 1)}${comma}${eol}  "references": [{ "path": "${CHAIN_REF}" }]${gap}${rest}`
}

/**
 * What the root config should become, as text, or `null` for no write.
 *
 * Two repairs, in order. The direct references earlier releases wrote are
 * stripped ({@link stripGeneratedReferences}). Then the chain reference is
 * added, unless the root already has it or claims app files of its own, in
 * which case adding it would break `tsc -p` ({@link claimsAppFiles}) and the
 * caller says so instead.
 *
 * Pure, and the place the rule "a root never references `.cache/tsconfig/`"
 * is held: the only entry it ever adds is the chain file.
 */
export function wireRoot(
  text: string,
  base: Record<string, unknown> | null,
): { text: string | null; stripped: boolean; wired: boolean; claims: boolean } {
  let root = parseJSONC(text) as Record<string, unknown>
  let out: string | null = null

  const repaired = stripGeneratedReferences(root)
  if (repaired) {
    root = repaired
    out = `${JSON.stringify(repaired, null, 2)}\n`
  }
  const stripped = repaired !== null

  if (referencesChain(root)) {
    return { text: out, stripped, wired: false, claims: false }
  }
  if (claimsAppFiles(root, base)) {
    return { text: out, stripped, wired: false, claims: true }
  }

  const refs = Array.isArray(root.references) ? root.references : null
  const wired =
    (refs ? null : insertChainReference(out ?? text)) ??
    `${JSON.stringify({ ...root, references: [...(refs ?? []), { path: CHAIN_REF }] }, null, 2)}\n`
  return { text: wired, stripped, wired: true, claims: false }
}

/**
 * The root config written when the app has none at all.
 *
 * The generated projects do not help Bun's runtime: it reads
 * `compilerOptions.jsx*` from the root `tsconfig.json` and follows `extends`
 * only into a relative path, never a package specifier, so the file this
 * writes has to carry the JSX options itself, inline, exactly as the
 * scaffolder spells them.
 *
 * It claims no app files: it inherits only core's ambient declarations, and
 * reaches everything else through the chain, which is the one shape the
 * chain is legal in (see {@link claimsAppFiles}).
 */
export function defaultRootConfig(): Record<string, unknown> {
  return {
    extends: '@bakery-framework/core/tsconfig.server.json',
    compilerOptions: {
      jsx: 'react',
      jsxFactory: 'createElement',
      jsxFragmentFactory: 'Fragment',
    },
    references: [{ path: CHAIN_REF }],
  }
}

/**
 * Generate the scope projects, list them in `tsconfig.bakery.json`, and wire
 * the app's root tsconfig to that file.
 *
 * Separate from `syncTSConfigPaths` because an app can reasonably want one and
 * not the other: the paths sync has existed for a long time and rewrites a file
 * people keep in git, while this owns a directory nobody edits.
 *
 * **Who owns what.** `.cache/tsconfig/*.json` and `tsconfig.bakery.json` are
 * generated, and edits to them are lost. `tsconfig.json` is the developer's:
 * the only change made to it is the one `references` entry for the chain,
 * inserted as text so its comments survive, plus the one-time strip of the
 * direct references earlier releases wrote.
 *
 * **Why the chain.** An editor gives a file to the project that claims it.
 * With the projects standing alone, nothing pointed an editor at them, so a
 * root that claimed nothing left every app file in an inferred project, and
 * `Bun` was unknown in every `api/` file. Through the chain each file gets its
 * scope: `api/` and pages to server-side projects, other `.ts` to `client`, an
 * SFC to plugin-vue's project. `tsc -b` checks all of them at once.
 *
 * **Only for a root that claims no app files.** One that does fails
 * `tsc -p` with TS6305 once per shared file when chained, so it is left as it
 * is, with a line saying how to move ({@link claimsAppFiles}). Said when the
 * chain file changes rather than on every boot, since keeping the old shape
 * can be deliberate.
 *
 * **A fresh clone has none of these files** until something generates them,
 * and `tsc` then stops at TS6053 on the chain's references. `bakery --types`
 * generates them without starting a server, so a clone, a CI job or a
 * `typecheck` script can run it first. The cache wipe keeps
 * `.cache/tsconfig/` for the same reason (`WIPE_KEEP` in `cache-version.ts`).
 *
 * Two earlier lessons still bind the root-config half. It used to be
 * *replaced* with a references-only stub, which silently broke every `.tsx`
 * page: Bun's runtime reads `compilerOptions.jsx*` from the root and does not
 * follow `references`, so pages transpiled against the automatic JSX runtime
 * and `GET /` answered 200 with a JSON-encoded React element tree. Hence
 * {@link defaultRootConfig} when no root exists, and surgical edits (never a
 * wholesale rewrite) when one does. And a boot that dirties git every time
 * trains people to ignore the diff, so a root already in shape is not
 * rewritten, and neither is an unchanged chain file.
 */
export async function syncTSConfigProjects(): Promise<void> {
  try {
    const written = await writeProjects(buildPaths())
    const chainChanged = await writeChain(written)

    if (!fs.exists(APP_CONFIG_PATH)) {
      await Bun.write(
        APP_CONFIG_PATH,
        `${JSON.stringify(defaultRootConfig(), null, 2)}\n`,
      )
      serveLog.TSCONFIG_PROJECTS_WRITTEN({ count: String(written.length) })
      return
    }

    const text = await Bun.file(APP_CONFIG_PATH).text()
    const plan = wireRoot(text, baseConfigOf(parseJSONC(text)))

    if (plan.text !== null) await Bun.write(APP_CONFIG_PATH, plan.text)
    if (plan.stripped) serveLog.TSCONFIG_REFERENCES_REMOVED()
    if (plan.wired) serveLog.TSCONFIG_CHAIN_WIRED()
    if (plan.claims && chainChanged) serveLog.TSCONFIG_ROOT_CLAIMS_FILES()
  } catch (err: any) {
    serveLog.UNHANDLED_ERR({
      error: `TSConfig project sync error: ${errorMsg(err)}`,
    })
  }
}

export async function syncTSConfigPaths(): Promise<void> {
  try {
    const newPaths = buildPaths()
    let appConfig: any = { compilerOptions: { paths: {} } }

    if (fs.exists(APP_CONFIG_PATH)) {
      appConfig = parseJSONC(await Bun.file(APP_CONFIG_PATH).text())
    }

    appConfig.compilerOptions ??= {}
    delete appConfig.compilerOptions.baseUrl

    const currentPaths = appConfig.compilerOptions.paths ?? {}

    if (Bun.deepEquals(currentPaths, newPaths)) return

    appConfig.compilerOptions.paths = newPaths
    await Bun.write(APP_CONFIG_PATH, JSON.stringify(appConfig, null, 2))

    serveLog.TSCONFIG_SYNCED()
  } catch (err: any) {
    serveLog.UNHANDLED_ERR({ error: `TSConfig sync error: ${errorMsg(err)}` })
  }
}
