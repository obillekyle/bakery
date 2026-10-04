import { Bakery } from '@bakery-framework/core/core/bakery'
import { Logger } from '@bakery-framework/core/logger'
import { fs, toHash } from '@bakery-framework/core/utils'
import { vueBuildVariant, vuePluginOptionsFingerprint } from './compile'
import { cacheDir, VUE_VERSION } from './utils'

/**
 * What `bakery --build` leaves behind, and what a production server reads of
 * it. The bundler itself is `build.ts`, which the server never loads.
 */

const logger = new Logger('vue')

/** Where the build lives: disposable, like the rest of `.cache/`. */
export const BUILD_DIR = fs.resolve(cacheDir, 'build')

/** The URL prefix the build's files are served under. */
export const BUILD_URL = '/_vue/build/'

/**
 * Bumped when the manifest or the bundled code changes shape, so a server
 * never reads a build an older plugin made.
 */
export const BUILD_FORMAT = 1

/**
 * Where a built page's HTML puts the exports of the server blocks of the
 * components it reaches, keyed by route path.
 */
export const SERVER_MODULES_GLOBAL = '__vue_server_modules'

/**
 * What a bundled component with a `<script server>` block reads its exports
 * from, in place of the data a served one has spliced in.
 *
 * A block that answered with a response instead of data (a middleware's 401,
 * a redirect) is recorded as `{ __bakeryResponse: status }`, and the
 * component throws as it loads. Served, the same answer fails the component's
 * module request, which fails the import: the page breaks either way, and the
 * error says why.
 */
export function moduleServerData(routePath: string): string {
  const key = JSON.stringify(routePath)
  const message = JSON.stringify(
    `${routePath}: its <script server> block answered with a response, not data: HTTP `,
  )
  return (
    `((d) => { if (d && d.__bakeryResponse) throw new Error(${message} + d.__bakeryResponse); return d || {} })` +
    `((globalThis.${SERVER_MODULES_GLOBAL} || {})[${key}])`
  )
}

/** One page, as the build made it. */
export interface BuiltPage {
  /** The entry chunk's URL. */
  script: string
  /** Chunks the entry imports statically, preloaded beside it. */
  preload: string[]
  /** Stylesheet URLs: the layout's first, then the page's. */
  css: string[]
  /**
   * Route paths of the components the page can reach that carry a
   * `<script server>` block. Their blocks run with the page request, and
   * their exports arrive in the HTML.
   */
  serverModules: string[]
}

export interface BuildManifest {
  format: number
  /** The Vue the render functions were compiled for. */
  vue: string
  /** The plugin options and import map the build was made under. */
  fingerprint: string
  /** Every file the bundle read, with the mtime it had then. */
  inputs: Record<string, number>
  /** Each serve root's `layout.vue` files at build time. */
  layouts: Record<string, string[]>
  /** Every file under the build directory the server may hand out. */
  files: string[]
  /** Serve root, then page file, both absolute. */
  roots: Record<string, Record<string, BuiltPage>>
}

/**
 * The options and the import map the build depends on, as one value.
 *
 * Every import-map key is left out of the bundle for the browser to resolve,
 * `vue` among them, so adding or removing one changes what the bundle should
 * contain without touching a source file. The plugin's options change the
 * compiled templates the same way.
 */
export function buildFingerprint(): string {
  const keys = new Set(Object.keys(Bakery.config.importMap ?? {}))
  for (const host of Object.values(Bakery.config.hosts ?? {})) {
    for (const key of Object.keys(host.importMap ?? {})) keys.add(key)
  }
  return toHash(
    JSON.stringify([
      vueBuildVariant(),
      vuePluginOptionsFingerprint(),
      [...keys].sort(),
    ]),
  )
}

/** Each root's `layout.vue` files, sorted, for the manifest and the check. */
export async function layoutsUnder(root: string): Promise<string[]> {
  const found: string[] = []
  for await (const file of new Bun.Glob('**/layout.vue').scan({
    cwd: root,
    absolute: true,
    onlyFiles: true,
  })) {
    found.push(fs.resolve(file))
  }
  return found.sort()
}

/**
 * Why the manifest no longer describes the app, or null when it still does.
 *
 * Inputs are compared by mtime, the same test every compile cache here uses.
 * Layouts are listed separately because adding one changes what wraps a page
 * without touching any file the build read.
 */
export async function staleReason(
  manifest: BuildManifest,
): Promise<string | null> {
  if (manifest.format !== BUILD_FORMAT) {
    return 'it was made by another version of the plugin'
  }
  if (manifest.vue !== VUE_VERSION) {
    return `it was compiled for Vue ${manifest.vue}, and ${VUE_VERSION} is installed`
  }
  if (manifest.fingerprint !== buildFingerprint()) {
    return 'the Vue plugin options or the import map changed'
  }
  for (const [path, mtime] of Object.entries(manifest.inputs)) {
    const file = Bun.file(path)
    if (!fs.exists(file)) return `${path} is gone`
    if (file.lastModified !== mtime) return `${path} changed`
  }
  for (const [root, layouts] of Object.entries(manifest.layouts)) {
    const now = await layoutsUnder(root)
    if (now.join('\n') !== layouts.join('\n')) {
      return `a layout.vue was added or removed under ${root}`
    }
  }
  return null
}

let loaded: Promise<{
  manifest: BuildManifest
  files: Set<string>
} | null> | null = null

/**
 * The build, once per process, or null: in development, when there is none,
 * and when it no longer matches the app. Production has no watcher and the
 * page tree only changes with a restart (see `claimedBeside`), so one check
 * is the whole of it, and a server started before a build keeps serving what
 * it found.
 */
export function loadBuild(): Promise<{
  manifest: BuildManifest
  files: Set<string>
} | null> {
  if (import.meta.env.PROD !== '1') return Promise.resolve(null)
  loaded ??= readBuild()
  return loaded
}

async function readBuild() {
  const file = Bun.file(`${BUILD_DIR}/manifest.json`)
  if (!(await file.exists())) return null

  let manifest: BuildManifest
  try {
    manifest = (await file.json()) as BuildManifest
  } catch (error) {
    logger.log(
      `The Vue build's manifest is unreadable (${String(error)}): pages are served unbundled until \`bakery --build\` runs again.`,
      'warn',
    )
    return null
  }

  const reason = await staleReason(manifest)
  if (reason) {
    logger.log(
      `The Vue build is out of date (${reason}): pages are served unbundled until \`bakery --build\` runs again.`,
      'warn',
    )
    return null
  }
  return { manifest, files: new Set(manifest.files) }
}

/** The built page for a file under a root, or null to serve it unbundled. */
export async function builtPage(
  root: string,
  file: string,
): Promise<BuiltPage | null> {
  const build = await loadBuild()
  return build?.manifest.roots[fs.resolve(root)]?.[fs.resolve(file)] ?? null
}

/** Test seam (convention 9): forget the memoized build. */
export function __resetBuild(): void {
  loaded = null
}
