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
// a tsconfig *inside the framework* — app-specific paths mutating a shipped
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
 * The two projects core always generates.
 *
 * The split is the whole point: only `server` carries `bun-types`, so `Bun.*`
 * in a file bound for the browser is a type error rather than a runtime one.
 * Before this existed, one config covered everything and `Bun.hash()` in a
 * client file typechecked clean and failed in the browser.
 *
 * The includes overlap the app's own tsconfig, and that is fine *because
 * nothing references these projects*: each is a standalone projection of one
 * concern, pointed at directly (`tsc -p .cache/tsconfig/client.json`), and
 * subtracting the app's include would gut them into projects that check
 * nothing. What must never come back is the `references` wiring that composed
 * them with the app project — see {@link syncTSConfigProjects}.
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
      include: [
        `${root}/**/api/**/*.ts`,
        `${root}/**/*.tsx`,
        'server.config.ts',
        'schema.ts',
        'orm/**/*.ts',
      ],
    },
    {
      name: 'client',
      extends: '@bakery-framework/core/tsconfig.app.json',
      include: [`${root}/**/*.ts`],
      exclude: [`${root}/**/api/**/*.ts`],
      // The only project that gets `importMap` aliases, because the import map
      // is a browser mechanism — see `importMapPaths` on `PluginTsProject`.
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
  // `../../C:/WebDAV/.../src/**/*.ts`, which matches nothing — and a project
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
 * A package specifier is the useful form for a plugin to write — it does not
 * know where it was installed — but `files` is resolved as a path, so
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
 * `tsconfig.vue.json` lists core's three ambient declarations — `global.d.ts`,
 * `shared.d.ts`, `types.d.ts` — which is where `Bakery`, `AppConfig`, the JSX
 * namespace and `Request.session` come from. `@bakery-framework/plugin-vue`
 * declares one `files` entry of its own for `vue.d.ts`, and that one entry
 * replaced all three: measured on a real app, the generated `vue` project loaded
 * **zero** of them.
 *
 * It hid because `vue.d.ts` happens to declare `req` and `body` itself, so the
 * globals an SFC reaches for most still resolved. Everything else — `Bakery`,
 * `MapOf`, the JSX namespace — was quietly missing.
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
    // just loses the ambients — which is the status quo this repairs, not a
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
 * `MapOf<MapOf<any>>` — the ORM's documented untyped mode, arrived at by
 * accident. It does not error; it just stops checking.
 *
 * **Server-side projects only.** The client project deliberately does not get
 * it: the ORM is server-only, so a browser file importing `DB` should fail to
 * typecheck rather than be helpfully typed. That is not only a preference —
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
    // any of its own, because a child's `files` *replaces* the parent's — see
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
        // nowhere else — writing them into the server project made an import
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
 *   project is TS6306 and to a `noEmit` one TS6310 — **even when the
 *   referenced project's include is disjoint from the root's, and even when
 *   it matches zero files**. No include shape survives.
 * - Each root file a referenced project also claims is redirected to that
 *   project's declaration output, which `noEmit` guarantees was never built:
 *   TS6305, once per overlapping file — `src/**`, `server.config.ts`, every
 *   `.tsx` page.
 *
 * The generated projects extend `noEmit` bases and rely on
 * `allowImportingTsExtensions`, so they are unbuildable by design. Making them
 * `composite` instead would trade the errors above for a `tsc -b` build-order
 * requirement no consumer runs — and TS6305 would still fire for any root file
 * importing into one while unbuilt. The only reference shape `tsc -p`
 * tolerates from a root that has files of its own is no reference at all, so
 * the projects stand alone now and this strips what previous releases wrote.
 *
 * Everything the developer owns is preserved: only entries into
 * `.cache/tsconfig/` are removed, a real project reference (say `../shared`)
 * stays, and the `references` key itself survives unless the generator wrote
 * every entry in it.
 *
 * Pure, and exported, so the repair can be tested without a function that
 * writes to `process.cwd()`. The property that matters is negative — *no key
 * the developer wrote is lost* — which a shape assertion on the source cannot
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

/**
 * The root config written when the app has none at all.
 *
 * The generated projects do not help Bun's runtime — it reads
 * `compilerOptions.jsx*` from the root `tsconfig.json` and follows `extends`
 * only into a relative path, never a package specifier — so the file this
 * writes has to carry the JSX options itself, inline, exactly as the
 * scaffolder spells them.
 */
export function defaultRootConfig(): Record<string, unknown> {
  return {
    extends: '@bakery-framework/core/tsconfig.server.json',
    compilerOptions: {
      jsx: 'react',
      jsxFactory: 'createElement',
      jsxFragmentFactory: 'Fragment',
    },
  }
}

/**
 * Generate the project configs, and keep the app's root tsconfig viable —
 * created with the runtime JSX options when the app has none, and stripped of
 * the `references` a previous release wrote into it.
 *
 * Separate from `syncTSConfigPaths` because an app can reasonably want one and
 * not the other: the paths sync has existed for a long time and rewrites a file
 * people keep in git, while this owns a directory nobody edits.
 *
 * **The generated projects are standalone on purpose; the root config does not
 * reference them.** They exist for direct invocation against the one concern
 * each covers: `vue-tsc -p .cache/tsconfig/vue.json` is the only way an SFC
 * typechecks at all, `tsc -p .cache/tsconfig/client.json` proves browser code
 * clean of `Bun.*`, and a plugin's project carries its own ambients the same
 * way. Their `include` deliberately overlaps the app's own project — they are
 * alternate projections of the same files, used *instead of* the root for
 * their slice, never composed with it. Wiring them in as `references` broke
 * `tsc -p <app>` for any consumer who had booted once (TS6305/6306/6310 — the
 * measurements are on {@link stripGeneratedReferences}), and what the wiring
 * bought was less than it looked: tsserver routes a file to the project whose
 * `include` claims it, so for everything a scaffolded root claims — `src/**`,
 * `server.config.ts`, `orm/**` — the reference walk never ran anyway.
 *
 * Two earlier lessons still bind the root-config half. It used to be
 * *replaced* with a references-only stub, which silently broke every `.tsx`
 * page: Bun's runtime reads `compilerOptions.jsx*` from the root and does not
 * follow `references`, so pages transpiled against the automatic JSX runtime
 * and `GET /` answered 200 with a JSON-encoded React element tree. Hence
 * {@link defaultRootConfig} when no root exists, and surgical repair — never
 * wholesale rewrite — when one does. And a boot that dirties git every time
 * trains people to ignore the diff, so an already-clean root is not rewritten.
 */
export async function syncTSConfigProjects(): Promise<void> {
  try {
    const written = await writeProjects(buildPaths())

    const current = fs.exists(APP_CONFIG_PATH)
      ? parseJSONC(await Bun.file(APP_CONFIG_PATH).text())
      : null

    if (!current) {
      await Bun.write(
        APP_CONFIG_PATH,
        `${JSON.stringify(defaultRootConfig(), null, 2)}\n`,
      )
      serveLog.TSCONFIG_PROJECTS_WRITTEN({ count: String(written.length) })
      return
    }

    const repaired = stripGeneratedReferences(current)
    if (!repaired) return

    await Bun.write(APP_CONFIG_PATH, `${JSON.stringify(repaired, null, 2)}\n`)
    serveLog.TSCONFIG_REFERENCES_REMOVED()
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
