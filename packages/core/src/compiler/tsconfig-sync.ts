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
 * Globs are app-relative here and rewritten to be relative to the generated
 * file, which sits two levels down.
 */
export function coreProjects(): PluginTsProject[] {
  const root = Bakery.config.root ?? 'src'

  return [
    {
      name: 'server',
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

  for (const project of allProjects()) {
    const files = (project.files ?? [])
      .map(entry => {
        const resolved = resolveFilesEntry(entry)
        if (!resolved) {
          serveLog.TSCONFIG_FILE_UNRESOLVED({ entry })
        }
        return resolved
      })
      .filter((f): f is string => f !== null)

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
 * The app's root tsconfig with `references` set, and nothing else touched.
 *
 * Pure, and exported, so the merge can be tested without a function that writes
 * to `process.cwd()`. The property that matters is negative — *no key the
 * developer wrote is lost* — which is the kind of thing a shape assertion on the
 * source cannot check.
 */
export function mergeRootConfig(
  current: Record<string, unknown> | null,
  references: { path: string }[],
): Record<string, unknown> {
  // Spread first so `references` is the only key this owns.
  if (current) return { ...current, references }

  // No root config at all. The generated projects do not help Bun's runtime, so
  // the one this writes has to carry the JSX options itself.
  return {
    extends: '@bakery-framework/core/tsconfig.server.json',
    compilerOptions: {
      jsx: 'react',
      jsxFactory: 'createElement',
      jsxFragmentFactory: 'Fragment',
    },
    references,
  }
}

/**
 * Generate the project configs and add `references` to the app's root tsconfig.
 *
 * Separate from `syncTSConfigPaths` because an app can reasonably want one and
 * not the other: the paths sync has existed for a long time and rewrites a file
 * people keep in git, while this owns a directory nobody edits.
 *
 * **It used to replace the root config with a references-only stub, and that
 * silently broke every `.tsx` page in the app.** The reasoning was tidy — the
 * generated projects carry the JSX options, so the root does not need them — and
 * it was wrong about *who reads the root*. `tsc` follows `references`; **Bun's
 * runtime does not.** Bun reads `compilerOptions.jsx*` from the root
 * `tsconfig.json` and nothing else, so a references-only root means pages get
 * transpiled against the automatic JSX runtime instead of Bakery's
 * `createElement`.
 *
 * The symptom is worse than the 500 that mistake usually produces. Measured on a
 * scratch app: `GET /` answered **200** with
 * `{"type":"html","props":{…},"_owner":null,"_store":{}}` — a React element tree,
 * JSON-encoded, because the handler received an object where it expects a
 * `SafeHtml` string. Nothing logs, nothing throws, the status is fine.
 *
 * So the root is now *merged*, not replaced: every key the developer wrote stays,
 * and only `references` is ours. That also settles the contradiction with the
 * scaffolder, which writes those JSX options under a comment saying to keep them
 * — and with the three documentation pages that repeat it.
 */
export async function syncTSConfigProjects(): Promise<void> {
  try {
    const written = await writeProjects(buildPaths())

    const references = written.map(name => ({
      path: `./.cache/tsconfig/${name}.json`,
    }))

    const current = fs.exists(APP_CONFIG_PATH)
      ? parseJSONC(await Bun.file(APP_CONFIG_PATH).text())
      : null

    // Only rewrite when the reference set actually changed. The root config is
    // committed, and a dev boot that dirties git every time trains people to
    // ignore the diff.
    if (current && Bun.deepEquals(current.references, references)) return

    const root = mergeRootConfig(current, references)

    await Bun.write(APP_CONFIG_PATH, `${JSON.stringify(root, null, 2)}\n`)
    serveLog.TSCONFIG_PROJECTS_WRITTEN({ count: String(written.length) })
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
