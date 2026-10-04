import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { clientDefines } from '@bakery-framework/core/compiler'
import { Bakery, hostKey, hostStore } from '@bakery-framework/core/core/bakery'
import { resolveHostConfig } from '@bakery-framework/core/core/config'
import { errorMsg, Logger } from '@bakery-framework/core/logger'
import { fs, toHash } from '@bakery-framework/core/utils'
import {
  BUILD_DIR,
  BUILD_FORMAT,
  BUILD_URL,
  type BuildManifest,
  type BuiltPage,
  buildFingerprint,
  layoutsUnder,
  moduleServerData,
} from './built'
import {
  componentCss,
  componentScript,
  ROOT_SERVER_DATA,
  VueHandler,
} from './handler'
import { cacheDir, parseVueMeta, VUE_VERSION } from './utils'

/**
 * `bakery --build` for Vue pages: every page under every serve root bundled
 * with `Bun.build`, into content-hashed chunks a production server hands out
 * with immutable caching. Served unbundled, a page costs a request per
 * component, per imported module and per package (48 to 51 for a cold admin
 * page of a real app with 40 components); built, it costs the shell, the Vue
 * runtime, its entry chunk with the chunks it shares with other pages, and
 * its stylesheets.
 *
 * Components are compiled by the same function that serves them
 * (`componentScript`), with their imports left for the bundler to resolve
 * against the files on disk. Import-map keys stay out of the bundle, for the
 * browser's import map to resolve: `vue` above all, since two copies of Vue
 * in one page is broken reactivity, and the runtime at `/_vue/` is the copy
 * every unbundled module already shares.
 *
 * A component's `<script server>` block never reaches the bundle, as it never
 * reaches the browser. What reaches it is the expression the component reads
 * its exports from: the page's HTML carries them, because a built page runs
 * the blocks of every component it can reach (see `builtModuleData`).
 */

const logger = new Logger('vue')

/**
 * A stand-in name for a module, in the directory of the file it stands for.
 *
 * Two things need one. A page's entry compiles as a root script (mounted, not
 * imported), so it is a different module from the same file imported as a
 * component, and needs a name of its own. And Bun 1.4.2 refuses any path a
 * plugin resolves to that contains `...` ("must be absolute when the
 * namespace is file"), measured on `[...slug].vue` and `a...b.vue` alike,
 * with `[id].vue` and `[x]y.vue` accepted: so every catch-all page needs one.
 *
 * In the real file's directory, so relative imports and package lookups
 * resolve from where the file is.
 */
const RX_ALIAS = /__bakery_(page|file)_[a-z0-9]+\.[a-z]+$/

function aliasFor(ctx: RootContext, file: string, page: boolean): string {
  const ext = file.slice(file.lastIndexOf('.'))
  const alias = `${fs.dirname(file)}/__bakery_${page ? 'page' : 'file'}_${toHash(file)}${ext}`
  ctx.aliases.set(alias, { file, page })
  return alias
}

/** A resolved path Bun can take: the file's own, or a stand-in when it needs one. */
function resolved(ctx: RootContext, file: string): string {
  return file.includes('...') ? aliasFor(ctx, file, false) : file
}

/** The serve roots to build: the base one, then each host's own. */
function serveRoots(): { root: string; hostname: string }[] {
  const base = fs.resolve(Bakery.config.root)
  const roots = [{ root: base, hostname: '' }]
  const seen = new Set([base])
  // A host without a root of its own serves the base root's files, and the
  // base build serves it: the bundle's scope ids and data keys depend on the
  // files alone.
  for (const [hostname, entry] of Object.entries(Bakery.config.hosts ?? {})) {
    if (!entry.root) continue
    const root = fs.resolve(entry.root)
    if (seen.has(root)) continue
    seen.add(root)
    roots.push({ root, hostname: hostname.toLowerCase() })
  }
  return roots
}

/**
 * Every `.vue` file under `root` a request could render as a page: not a
 * layout, not `module-only`, and not a file the server refuses to serve, whose
 * code would otherwise sit in a chunk anybody could fetch by name.
 */
async function discoverPages(root: string): Promise<string[]> {
  const blocked = Bakery.config.blocked
  const pages: string[] = []
  for await (const found of new Bun.Glob('**/*.vue').scan({
    cwd: root,
    absolute: true,
    onlyFiles: true,
  })) {
    const file = fs.resolve(found)
    if (file.endsWith('/layout.vue')) continue
    if (file.includes('/node_modules/')) continue
    if (fs.isForbidden(file, root) || blocked?.match(file)) continue
    const { meta } = parseVueMeta(await Bun.file(file).text())
    if (meta.moduleOnly) continue
    pages.push(file)
  }
  return pages.sort()
}

function isExternal(specifier: string, externals: string[]): boolean {
  return externals.some(key =>
    key.endsWith('/') ? specifier.startsWith(key) : specifier === key,
  )
}

/**
 * A specifier written the way served code writes it: from the serve root, and
 * perhaps with a query. Resolved the way the handlers resolve the URL: the
 * file, a `.js` name for a `.ts` file, or an extensionless name with its
 * extension or its directory's index.
 */
function resolveRooted(root: string, specifier: string, importer: string) {
  const clean = decodeURIComponent(specifier.replace(/[?#].*$/, ''))
  const base = fs.resolve(root, `.${clean}`)
  if (base !== root && !base.startsWith(`${root}/`)) {
    throw new Error(
      `${specifier}, imported by ${importer}, leaves the serve root`,
    )
  }
  const candidates = [
    base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : '',
    `${base}.ts`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ]
  for (const candidate of candidates) {
    if (candidate && fs.isFileSync(candidate)) return candidate
  }
  throw new Error(
    `${specifier}, imported by ${importer}, names no file under ${root}`,
  )
}

/** A served module injects an imported stylesheet; so does a bundled one. */
function stylesheetModule(css: string): string {
  return (
    `(function(){var s=document.createElement('style');` +
    `s.textContent=${JSON.stringify(css)};document.head.appendChild(s)})();` +
    'export default null;'
  )
}

interface RootContext {
  root: string
  externals: string[]
  /** Components with a server block, as they are loaded: file to route path. */
  serverModules: Map<string, string>
  /** Stand-in names (`aliasFor`), to the file and whether it is a page. */
  aliases: Map<string, { file: string; page: boolean }>
}

/** The real file a loaded path is, and whether it is a page's entry. */
function realFile(ctx: RootContext, path: string) {
  const normalized = fs.resolve(path)
  return ctx.aliases.get(normalized) ?? { file: normalized, page: false }
}

/** One component, compiled for the bundle. */
async function compileForBundle(ctx: RootContext, path: string) {
  const { file, page: isPage } = realFile(ctx, path)
  const relPath = fs.relative(ctx.root, file)
  if (relPath === '..' || relPath.startsWith('../')) {
    throw new Error(
      `${file} is outside the serve root ${ctx.root}, and only components under it compile`,
    )
  }
  const routePath = `/${relPath}`
  const id = toHash(hostKey(relPath))
  const disk = Bun.file(file)
  const parsed = await VueHandler.parseVueFile(
    id,
    disk,
    file,
    disk.lastModified,
  )
  const hasServerBlock = Boolean(parsed.serverScript.trim())

  if (!isPage && parsed.meta.pageOnly) {
    throw new Error(
      `${routePath} is page-only, and a component imports it: served unbundled, that import is refused`,
    )
  }
  if (!isPage && hasServerBlock) ctx.serverModules.set(file, routePath)

  return componentScript({
    id,
    routePath,
    isRootScript: isPage,
    parsed,
    served: false,
    serverData: hasServerBlock
      ? isPage
        ? ROOT_SERVER_DATA
        : moduleServerData(routePath)
      : undefined,
  })
}

function bundlePlugin(ctx: RootContext): Bun.BunPlugin {
  return {
    name: 'bakery-vue-build',
    setup(build) {
      build.onResolve({ filter: RX_ALIAS }, args => ({ path: args.path }))

      build.onResolve({ filter: /.*/ }, args => {
        const specifier = args.path
        if (isExternal(specifier, ctx.externals)) {
          return { path: specifier, external: true }
        }
        if (specifier.startsWith('/') && !specifier.startsWith('//')) {
          const file = resolveRooted(ctx.root, specifier, args.importer)
          return { path: resolved(ctx, file) }
        }
        // A relative `.vue` import carrying the query served code adds.
        const query = specifier.indexOf('?')
        if (
          query !== -1 &&
          specifier.startsWith('.') &&
          specifier.slice(0, query).endsWith('.vue')
        ) {
          const importer = realFile(ctx, args.importer).file
          const file = fs.resolve(
            fs.dirname(importer),
            specifier.slice(0, query),
          )
          return { path: resolved(ctx, file) }
        }
        return undefined
      })

      build.onLoad({ filter: /\.vue$/ }, async args => ({
        contents: await compileForBundle(ctx, args.path),
        loader: 'js',
      }))

      // A stand-in for a script with `...` in its name: the real file's text.
      build.onLoad(
        { filter: /__bakery_file_[a-z0-9]+\.(ts|tsx|js|jsx|mjs)$/ },
        async args => {
          const { file } = realFile(ctx, args.path)
          const ext = file.slice(file.lastIndexOf('.') + 1)
          return {
            contents: await Bun.file(file).text(),
            loader: (ext === 'mjs' ? 'js' : ext) as 'ts' | 'tsx' | 'js' | 'jsx',
          }
        },
      )

      build.onLoad({ filter: /\.css$/ }, async args => ({
        contents: stylesheetModule(await Bun.file(args.path).text()),
        loader: 'js',
      }))
    },
  }
}

/** A build message with the file and line it names, when it names one. */
function describeBuildError(error: unknown): string {
  const message = (error as { message?: string })?.message ?? errorMsg(error)
  const position = (error as { position?: { file?: string; line?: number } })
    ?.position
  return position?.file
    ? `${position.file}:${position.line ?? 0}: ${message}`
    : message
}

type Metafile = NonNullable<Bun.BuildOutput['metafile']>

/** Every output reached from `start`, through the import kinds given. */
function reachable(
  outputs: Metafile['outputs'],
  start: string,
  kinds: string[],
): string[] {
  const seen = new Set([start])
  const queue = [start]
  while (queue.length) {
    for (const edge of outputs[queue.pop()!]?.imports ?? []) {
      if (!kinds.includes(edge.kind) || !(edge.path in outputs)) continue
      if (seen.has(edge.path)) continue
      seen.add(edge.path)
      queue.push(edge.path)
    }
  }
  return [...seen]
}

/** A metafile output name as the URL it is served under. */
const servedAs = (output: string) =>
  `${BUILD_URL}${output.replace(/^\.\//, '')}`

/** A stylesheet, written once under a name its content decides. */
async function writeStylesheet(outdir: string, css: string): Promise<string> {
  const name = `s-${toHash(css)}.css`
  await Bun.write(`${outdir}/${name}`, css)
  return `${BUILD_URL}${name}`
}

/** The page's stylesheets, as `handleHtml` links them unbundled: layout first. */
async function pageStylesheets(
  root: string,
  page: string,
  outdir: string,
): Promise<string[]> {
  const relPath = fs.relative(root, page)
  const id = toHash(hostKey(relPath))
  const disk = Bun.file(page)
  const parsed = await VueHandler.parseVueFile(
    id,
    disk,
    page,
    disk.lastModified,
  )

  const urls: string[] = []
  if (parsed.layoutRoute) {
    const layoutFile = fs.resolve(root, `.${parsed.layoutRoute}`)
    const layoutId = toHash(hostKey(parsed.layoutRoute.slice(1)))
    const layoutDisk = Bun.file(layoutFile)
    const layout = await VueHandler.parseVueFile(
      layoutId,
      layoutDisk,
      layoutFile,
      layoutDisk.lastModified,
    )
    const css = await componentCss(layoutId, layout)
    if (css) urls.push(await writeStylesheet(outdir, css))
  }
  const css = await componentCss(id, parsed)
  if (css) urls.push(await writeStylesheet(outdir, css))
  return urls
}

async function buildRoot(
  root: string,
  outdir: string,
  manifest: BuildManifest,
): Promise<number> {
  manifest.layouts[root] = await layoutsUnder(root)
  manifest.roots[root] = {}
  const pages = await discoverPages(root)
  if (!pages.length) return 0

  const ctx: RootContext = {
    root,
    externals: Object.keys(Bakery.config.importMap ?? {}),
    serverModules: new Map(),
    aliases: new Map(),
  }

  let result: Bun.BuildOutput
  try {
    result = await Bun.build({
      entrypoints: pages.map(page => aliasFor(ctx, page, true)),
      outdir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      minify: true,
      metafile: true,
      define: await clientDefines(),
      // Names from content alone: a file's name changes exactly when its
      // bytes do, which is what makes immutable caching true. No source
      // names either, since `[...slug]` is not a name a URL carries well.
      naming: {
        entry: 'p-[hash].[ext]',
        chunk: 'c-[hash].[ext]',
        asset: 'a-[hash].[ext]',
      },
      plugins: [bundlePlugin(ctx)],
    })
  } catch (error) {
    // Bun throws an AggregateError whose message is only "Bundle failed";
    // what failed, and where, is in its `errors`.
    const causes = (error as { errors?: unknown[] }).errors ?? [error]
    const detail = causes.map(describeBuildError).join('\n  ')
    throw new Error(`bundling the pages under ${root} failed:\n  ${detail}`)
  }
  if (!result.success || !result.metafile) {
    const logs = result.logs.map(log => log.message).join('\n  ')
    throw new Error(`bundling the pages under ${root} failed:\n  ${logs}`)
  }

  const { inputs, outputs } = result.metafile
  const cwd = process.cwd()
  const absolute = (path: string) => realFile(ctx, fs.resolve(cwd, path)).file

  for (const input of Object.keys(inputs)) {
    const file = absolute(input)
    manifest.inputs[file] = Bun.file(file).lastModified
  }

  for (const [output, meta] of Object.entries(outputs)) {
    if (!meta.entryPoint) continue
    const page = absolute(meta.entryPoint)

    const preload = reachable(outputs, output, ['import-statement'])
      .filter(name => name !== output)
      .map(servedAs)

    const reached = new Set<string>()
    for (const name of reachable(outputs, output, [
      'import-statement',
      'dynamic-import',
    ])) {
      for (const input of Object.keys(outputs[name]?.inputs ?? {})) {
        reached.add(absolute(input))
      }
    }
    const serverModules = [...reached]
      .flatMap(file => ctx.serverModules.get(file) ?? [])
      .sort()

    const built: BuiltPage = {
      script: servedAs(output),
      preload,
      css: await pageStylesheets(root, page, outdir),
      serverModules,
    }
    manifest.roots[root][page] = built
  }
  return pages.length
}

/** `bakery --build`'s work for Vue: returns the manifest it wrote. */
export async function buildVuePages(): Promise<BuildManifest> {
  const started = performance.now()

  // What a build killed part way left behind: it never reached the swap, so
  // nothing reads it, and nothing else would ever remove it.
  for (const name of await readdir(cacheDir).catch(() => [] as string[])) {
    if (/^build-\d+-\d+$/.test(name)) {
      await rm(fs.resolve(cacheDir, name), { recursive: true, force: true })
    }
  }

  const temp = fs.resolve(cacheDir, `build-${process.pid}-${Date.now()}`)
  await mkdir(temp, { recursive: true })

  const manifest: BuildManifest = {
    format: BUILD_FORMAT,
    vue: VUE_VERSION,
    fingerprint: buildFingerprint(),
    inputs: {},
    layouts: {},
    files: [],
    roots: {},
  }

  let pages = 0
  try {
    for (const { root, hostname } of serveRoots()) {
      const run = () => buildRoot(root, temp, manifest)
      pages += hostname
        ? await hostStore.run(
            { hostname, config: resolveHostConfig(hostname) },
            run,
          )
        : await run()
    }

    manifest.files = (await readdir(temp)).sort()
    await Bun.write(`${temp}/manifest.json`, JSON.stringify(manifest))

    // Swapped in whole, so a server never reads half of one build and half
    // of another.
    await rm(BUILD_DIR, { recursive: true, force: true })
    await rename(temp, BUILD_DIR)
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }

  const ms = Math.round(performance.now() - started)
  logger.log(
    `Built ${pages} page${pages === 1 ? '' : 's'} into ${manifest.files.length} files in ${ms} ms (.cache/vue/build)`,
    'info',
  )
  return manifest
}
