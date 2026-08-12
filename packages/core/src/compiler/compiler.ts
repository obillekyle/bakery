import { Strings } from '../cache/string'
import { Bakery } from '../core/bakery'
import { PluginHooks } from '../core/plugins'
import {
  compLog,
  errorMsg,
  errorWithPosition,
  handlerLog,
} from '../logger/serve-log'
import type { MapOf } from '../types'
import { is, Try, toHash } from '../utils/common'
import { FileSystem as fs } from '../utils/fs'
import { installedPackages } from '../utils/http/dom'

const RX_IMPORT =
  /import\s+(?:(?:\*\s+as\s+)?([a-zA-Z_$\d\s{},/*]+?)\s+from\s+)?['"]([^'"]+?\.([a-zA-Z0-9]+))['"](?:\s+(?:with|assert)\s*\{[^}]+\})?\s*;?/gm

/**
 * The build-time `define` table, resolved on first use rather than at module
 * evaluation.
 *
 * This used to be a top-level `await` reading `<cwd>/package.json`, which put a
 * filesystem read on the boot path of every process that loads this module —
 * and `handlers/assets/ts.ts` imports it, so that is every worker and every dev
 * restart. The value it produces is needed only when something actually
 * compiles; a production process serving out of a warm compile cache never
 * needs it at all.
 *
 * Memoised as a promise, not a value, so two concurrent first compiles share
 * one read instead of racing to do it twice.
 */
let definesPromise: Promise<MapOf<string>> | null = null

async function buildDefines(): Promise<MapOf<string>> {
  let bakeryVersion = '1.0.0'
  try {
    const file = await Bun.file(`${process.cwd()}/package.json`).json()
    if (file?.version) bakeryVersion = file.version
  } catch {
    // No package.json in cwd, or it is unreadable. The version is cosmetic —
    // it lands in a banner and a build define — so the default above stands.
  }

  return {
    'import.meta.env.DEV': JSON.stringify(!!import.meta.env.DEV),
    'import.meta.env.PROD': JSON.stringify(!import.meta.env.DEV),
    'import.meta.env.WORKER': JSON.stringify(!!import.meta.env.WORKER),
    'import.meta.env.MODE': JSON.stringify(
      import.meta.env.MODE || 'production',
    ),
    'import.meta.env.BAKERY_VERSION': JSON.stringify(bakeryVersion),
  }
}

function getDefines(): Promise<MapOf<string>> {
  definesPromise ??= buildDefines()
  return definesPromise
}

let transpilerPromise: Promise<Bun.Transpiler> | null = null
function getTranspiler(): Promise<Bun.Transpiler> {
  transpilerPromise ??= getDefines().then(
    define =>
      new Bun.Transpiler({
        loader: 'ts',
        inline: true,
        trimUnusedImports: false,
        minifyWhitespace: true,
        target: 'browser',
        deadCodeElimination: false,
        define,
      }),
  )
  return transpilerPromise
}

let virtualIdCounter = 0
function nextVirtualId(): string {
  return (++virtualIdCounter).toString(36)
}

function preprocessImports(source: string, filePath: fs.AbsolutePath): string {
  const fileDir = fs.resolve(filePath)

  const matches = [...source.matchAll(RX_IMPORT)]

  for (const [string, varName, importPath, ext] of matches) {
    if (ext !== 'css' && ext !== 'json') continue

    const assetPath = fs.resolve(fileDir, importPath)

    // The key is the bare id, never the `/_virtual/` URL. Storing the full URL
    // meant getKey() returned an already-prefixed value that got prefixed again
    // on the next compile — which both threw a StringCache collision and left
    // VirtualAssetHandler (which looks up by bare id) unable to resolve it.
    const id =
      Strings.getKey(assetPath) || `${Date.now()}_${nextVirtualId()}.${ext}`

    const quotedUrl = JSON.stringify(`/_virtual/${id}`)

    const replacement = varName
      ? `const ${varName} = await Bakery.virtual(${quotedUrl});`
      : `await Bakery.virtual(${quotedUrl});`

    source = source.replace(string, () => replacement)
    Strings.set(id, assetPath)
  }

  return source
}

/**
 * Compile `source`, naming `path` so a failure can say where it happened.
 *
 * The two branches are not symmetric on purpose. Without a path there is no
 * file to name and no caller that can render a 500 — the Vue plugin compiles
 * fragments of an SFC it has already parsed — so a failure logs and hands the
 * source back. With a path the failure is a served request, and the answer is
 * `null`: `TSHandler` turns that into the 500 it has always had a branch for.
 *
 * It used to be neither. The transpiler was wrapped only on the pathless
 * branch, so a syntax error in a `.ts` asset threw straight past `compile()`,
 * past `TSHandler` — leaving its `'Compilation Failed'` arm permanently
 * unreachable — and into the worker's catch-all, which printed
 * `Unhandled Server Error: <message>` with no file and no line while the client
 * got `An unexpected error occurred.` A total blackout for a one-character typo.
 */
export function compileText(source: string): Promise<string>
export function compileText(
  source: string,
  path: fs.AbsolutePath,
): Promise<string | null>
export async function compileText(source: string, path?: fs.AbsolutePath) {
  if (!path) {
    try {
      const content = await (await getTranspiler()).transform(source)
      return content
    } catch (err) {
      compLog.COMPILE_SOURCE_FAIL({ error: errorMsg(err) })
      return source
    }
  }

  source = preprocessImports(source, path)

  const [failed, transformed] = await Try.catch(
    (await getTranspiler()).transform(source),
  )

  if (failed) {
    // `errorWithPosition`, not `errorMsg`: the thrown `BuildMessage` has no
    // stack, so `errorMsg` degrades to the bare message and the line number —
    // the only thing that makes this actionable — is dropped. The file comes
    // from `{file}`; the diagnostic's own `position.file` is `input.ts`,
    // because `transform()` was handed a string.
    compLog.COMPILE_FAIL({ file: path, error: errorWithPosition(failed) })
    return null
  }

  // **No import rewriting, of any kind.** Two generations of it lived here and
  // both corrupted user data the same way: a regular expression over
  // transpiled JavaScript cannot tell code from a string literal that merely
  // looks like an import. The bare-specifier -> `/_nm/` rewrite went first
  // (the import map covers every installed package); the `/index` append for
  // relative directory imports went second, once `ts.test.ts` pinned that the
  // handler already resolves `/lib`, `/lib.js` and their nested forms to the
  // directory's index server-side. Resolution belongs to the import map and
  // the handlers — the compiler only transpiles.
  return await PluginHooks.onCompile(transformed!, path)
}

export async function compile(
  path: fs.AbsolutePath | Bun.BunFile,
): Promise<string | null> {
  if (!fs.exists(path))
    throw new Error(`File not found: ${is.string(path) ? path : path.name}`)

  path = typeof path === 'string' ? Bun.file(path) : path
  return compileText(await path.text(), path.name! as fs.AbsolutePath)
}

type CompileResult = {
  success: boolean
  content?: string
  errors?: string[]
}

/**
 * A CommonJS package that assigns `module.exports` wholesale bundles to
 * `export default …` and nothing else.
 *
 * Not all CJS: `exports.greet = …` is statically analysable and Bun emits a real
 * named export for it. It is the whole-object form — `module.exports = { … }` —
 * whose members cannot be known without running the module, and that is the one
 * that breaks.
 *
 * That is correct output and a silent trap. The import map points a bare
 * specifier at `/_nm/<pkg>`, so `import { greet } from 'pkg'` in browser code
 * compiles happily, the bundle is served with a **200**, and the only sign of
 * trouble is a browser-side `SyntaxError: The requested module 'pkg' does not
 * provide an export named 'greet'`. Nothing reaches the server log.
 *
 * Detecting the shape is what lets `bundleCjsWithNamedExports` repair it. The
 * check is deliberately conservative: it fires only when the output has a
 * default export and no named one, *and* the bundle carries Bun's CJS wrapper.
 * An ESM package with only a default export is normal and says nothing.
 */
/**
 * Bun's CJS wrapper, in a spelling minification cannot destroy.
 *
 * The obvious check — `content.includes('__commonJS')` — held in dev and
 * silently never matched in PROD, where minification renames the helper to a
 * single letter. The consequence was the worst kind of split: named imports
 * of CJS packages worked all through development and broke only in the
 * deployed app. What survives minification is the helper's *body*: it always
 * constructs `{ exports: {} }`, spaces or not.
 */
const RX_CJS_WRAPPER = /\{\s*exports\s*:\s*\{\s*\}\s*\}/

/**
 * A `module.exports = { … }` assignment, whatever the module variable is
 * called after minification (`n.exports={…}`). The helper's own
 * `mod.exports);` never matches — no `= {` follows it.
 */
const RX_MODULE_EXPORTS = /[A-Za-z_$][\w$]*\.exports\s*=\s*\{/g

export function isCjsDefaultOnly(content: string): boolean {
  if (!RX_CJS_WRAPPER.test(content)) return false

  // `export {` covers the named-export block Bun emits; `export default` alone
  // is the shape that breaks a named import.
  const hasNamed = /\bexport\s*\{[^}]*\b(?!default\b)\w+/.test(content)
  if (hasNamed) return false

  return /\bexport\s+default\b|\bexport\s*\{\s*\w+\s+as\s+default\s*\}/.test(
    content,
  )
}

/**
 * A bundle consisting of nothing but a non-empty `export { … }` list.
 *
 * Such a file names bindings that were never declared, so every one of them is
 * a `ReferenceError` the moment the browser evaluates it — and `Bun.build`
 * reports it as **`success: true` with zero diagnostics**.
 *
 * The cause is `sideEffects`, and it is not specific to one package. When the
 * bundle *entry* is a file inside a package whose manifest declares
 * `sideEffects: false` (or `[]`, or a list not covering that file), Bun's
 * tree-shaker drops the entry's own imports while keeping its export list.
 * Reduced to a two-file fixture:
 *
 *     no `sideEffects` field   -> body 67 bytes
 *     `sideEffects: false`     -> body 0
 *     `sideEffects: []`        -> body 0
 *     `sideEffects: ["./x.js"]`-> body 0
 *     `sideEffects: true`      -> body 65 bytes
 *
 * `@vue-material/core@1.0.0-alpha.28` declares
 * `["./dist/attach-styles.js", "./dist/assets/*.css.js"]`, so its barrel
 * bundles to 3,549 bytes of pure export list and throws `AggregateError: 189
 * errors` on import. Most modern libraries set `sideEffects: false`, so any
 * re-export barrel among them is a candidate — this is a wide class, not a
 * single broken package.
 *
 * `bundleReExportShim` repairs it; this only recognises it. `export {}` on its
 * own is a legal empty module and is not flagged — the list has to name
 * something for the file to be self-contradictory.
 */
export function isEmptyExportList(content: string): boolean {
  const match = content.match(/export\s*\{([\s\S]*?)\}\s*;?\s*$/)
  if (!match) return false
  if (!match[1].trim()) return false

  return !content.slice(0, match.index).trim()
}

/**
 * Re-bundle a tree-shaken-to-nothing module through a shim outside the package.
 *
 * The `sideEffects` drop described on {@link isEmptyExportList} keys on the
 * *entry* being inside the offending package. Re-exporting the very same file
 * from a module that is not — the shim lands in `.cache/`, which is never
 * inside `node_modules` — leaves the tree-shaker with an entry it has no
 * manifest for, and the imports survive. Measured on `@vue-material/core`:
 * 3,549 bytes of husk becomes a 428,470-byte bundle with all 189 exports.
 *
 * Two attempts, because `export *` deliberately does not carry `default`, and
 * naming a `default` the package does not have is a hard build error rather
 * than a no-op. So: try with it, fall back to without.
 *
 * **Every installed package is `external`, and that is load-bearing rather than
 * an optimisation.** Left to itself the shim inlines the whole reachable tree —
 * `@vue-material/core` came out at 428KB with `vue` baked in, and `vue` is a
 * *peer* dependency the app resolves for itself. Two Vue runtimes in one page
 * is not a size problem, it is broken reactivity and a duplicated component
 * registry. Externalised, each dependency stays a bare specifier that the
 * import map sends to its own `/_nm/<dep>`, so there is exactly one copy of
 * each; the same bundle drops to 260KB.
 *
 * Externalising *installed packages* specifically, rather than Bun's
 * `packages: 'external'`, because that switch also externalises `node:*` —
 * turning a builtin Bun would otherwise polyfill for the browser into a bare
 * import nothing can resolve.
 */
async function bundleReExportShim(
  path: string,
  defines: MapOf<string>,
): Promise<string | null> {
  const spec = JSON.stringify(path)
  const shimPath = fs.resolve(
    Bakery.cacheDir,
    'nm_cache',
    `${toHash(path)}.reexport.mjs`,
  )
  const external = await installedPackages()

  for (const withDefault of [true, false]) {
    const shim =
      `export * from ${spec}\n` +
      (withDefault ? `export { default } from ${spec}\n` : '')

    const [writeErr] = await Try.catch(() => Bun.write(shimPath, shim))
    if (writeErr) return null

    // Wrapped, because naming a `default` the package does not export is a
    // *throw* from `Bun.build`, not a `success: false` — and that throw is the
    // expected outcome of the first attempt for any package without one.
    const [buildErr, build] = await Try.catch(() =>
      Bun.build({
        entrypoints: [shimPath],
        target: 'browser',
        format: 'esm',
        minify: Boolean(import.meta.env.PROD),
        define: defines,
        external,
      }),
    )

    if (buildErr || !build?.success || !build.outputs.length) continue

    const content = await build.outputs[0].text()
    // The shim is only worth serving if it actually carries the code the
    // original was missing; otherwise this is the same husk with extra steps.
    if (!isEmptyExportList(content)) return content
  }

  return null
}

/** A key that can be written as `export const <name> =`. */
const RE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const RESERVED_EXPORT_NAMES = new Set(['default', '__esModule'])

/**
 * How long the export probe may take before it is killed.
 *
 * Generous, because it pays a process start and a module evaluation, and it runs
 * once per package — the result is cached with the bundle. Short enough that a
 * package which hangs on import costs a pause rather than a wedged server.
 */
const CJS_PROBE_TIMEOUT_MS = 5_000

const OPENERS = '{[('
const CLOSERS = '}])'

/** Index of the separator ending the value that starts at `from`. */
function endOfValue(src: string, from: number): number {
  let depth = 0

  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (OPENERS.includes(c)) depth++
    else if (CLOSERS.includes(c)) {
      if (depth === 0) return i
      depth--
    } else if (c === ',' && depth === 0) return i
  }

  return src.length
}

/**
 * Top-level keys of the object literal whose `{` sits at `open`.
 *
 * Depth-counted rather than regex-matched, so a nested object or array in a
 * value does not end the scan early. Returns `null` if the literal never closes,
 * which is the signal to distrust the whole reading rather than guess.
 */
function objectLiteralKeys(src: string, open: number): string[] | null {
  const keys: string[] = []
  let depth = 0
  let keyStart = -1

  const take = (end: number) => {
    const piece = src.slice(keyStart, end).trim()
    if (piece) keys.push(piece)
  }

  for (let i = open; i < src.length; i++) {
    const c = src[i]

    if (OPENERS.includes(c)) {
      if (++depth === 1) keyStart = i + 1
      continue
    }

    if (CLOSERS.includes(c)) {
      if (--depth > 0) continue
      take(i)
      return keys
    }

    if (depth !== 1) continue

    if (c === ',') {
      take(i)
      keyStart = i + 1
      continue
    }

    if (c === ':') {
      take(i)
      // `{ a: expr, b }` — the value is skipped wholesale so a comma inside it
      // cannot be mistaken for the next key.
      i = endOfValue(src, i + 1)
      if (src[i] !== ',') return keys
      keyStart = i + 1
    }
  }

  return null
}

/**
 * Export names read out of the **bundled** output, without running anything.
 *
 * This is the job `cjs-module-lexer` does for Node and Vite: recognise a small
 * set of known-safe `module.exports` shapes and answer nothing for the rest. It
 * is deliberately one shape here — `module.exports = { … }`, the object literal
 * — because that is the only form that reaches this code path at all. Bun
 * already emits real named exports for `exports.name = …`, so a package written
 * that way never gets here.
 *
 * Reading the *bundle* rather than the source matters. Bun has already
 * normalised the module into a `__commonJS((exports, module) => { … })` wrapper,
 * so there is a single known shape to look inside. The string-literal hazard
 * that made the old import rewriter corrupt user code is reduced, not
 * eliminated — a string containing `module.exports = {` would still fool this —
 * which is why a failed or empty reading falls through to the probe instead of
 * being trusted as "no exports".
 */
export function staticCjsExportNames(bundled: string): string[] {
  // `RX_MODULE_EXPORTS`, not the literal `module.exports = {`: minification
  // renames the module variable and drops the spaces (`n.exports={`), and the
  // literal spelling made this reader dev-only — the probe silently took over
  // every PROD bundle.
  const matches = [...bundled.matchAll(RX_MODULE_EXPORTS)]
  if (matches.length === 0) return []
  // More than one assignment and the last one wins at runtime; rather than
  // model that, decline and let the probe answer.
  if (matches.length > 1) return []

  const match = matches[0]
  const keys = objectLiteralKeys(
    bundled,
    match.index + match[0].length - 1, // the `{` closing the match
  )
  if (!keys) return []

  return [
    ...new Set(
      keys
        .map(key => key.replace(/^["']|["']$/g, '').trim())
        .filter(key => RE_IDENTIFIER.test(key)),
    ),
  ]
}

/**
 * The export names of a CommonJS module, read **in a throwaway subprocess**.
 *
 * The fallback for whatever `staticCjsExportNames` cannot see. Something has to
 * run the module, and the question is only *where*: it used to be here, which
 * meant an arbitrary `node_modules` package executing inside the server process
 * — in production as well as dev — free to start a timer, open a socket, or
 * mutate a global that then outlives the request that caused it.
 *
 * A child process does not make execution safe, and nothing can: a module-scope
 * write to the filesystem still happens. What it buys is containment of
 * everything *in-process* — crashes, hangs, globals, listeners — and a package
 * that hangs on import is killed by the timeout rather than wedging a bundle.
 */
async function cjsExportNames(path: string): Promise<string[]> {
  // `process.stdout.write`, not `console.log`: a machine-read value on a pipe,
  // not a log line.
  const code =
    'const m = await import(process.argv[1]); ' +
    'process.stdout.write(JSON.stringify(Object.keys(m)))'

  const [spawnErr, names] = await Try.catch(async () => {
    const proc = Bun.spawn(['bun', '-e', code, path], {
      stdout: 'pipe',
      stderr: 'ignore',
    })

    const timer = setTimeout(() => proc.kill(), CJS_PROBE_TIMEOUT_MS)
    const out = await new Response(proc.stdout).text()
    clearTimeout(timer)
    // Killed or not, it must not outlive this call.
    proc.kill()

    // **The exit code is deliberately not consulted.** A package that leaves a
    // timer or a listener running — which plenty do at module scope — has
    // already printed its answer and then simply fails to exit, so the probe
    // kills it and the exit code reports the kill. Requiring a clean exit threw
    // away a correct result and fell back to default-only, which is the very
    // failure this exists to prevent. Valid JSON on stdout is the signal;
    // anything else falls back.
    const [, parsed] = await Try.catch(() => JSON.parse(out.trim()))
    return Array.isArray(parsed) ? (parsed as string[]) : []
  })

  if (spawnErr || !names) return []

  return names.filter(
    key => !RESERVED_EXPORT_NAMES.has(key) && RE_IDENTIFIER.test(key),
  )
}

/**
 * Re-bundle a `module.exports = { … }` package with real named exports.
 *
 * The names are read from the bundle, or failing that by importing the module,
 * and a shim generated that states them statically:
 *
 *     import __cjs from '<abs>'
 *     export default __cjs
 *     export const greet = __cjs.greet
 *
 * That shim is what gets bundled, so the browser gets a module that really does
 * provide `greet`. A package that throws on import — one touching `window` at
 * module scope, say — yields no names, and the caller keeps the plain bundle it
 * already has.
 *
 * Non-identifier keys are skipped rather than mangled: `module.exports['a-b']`
 * is legal CJS and is not a legal export name, and inventing one would be worse
 * than omitting it.
 */
async function bundleCjsWithNamedExports(
  path: string,
  defines: MapOf<string>,
  bundled: string,
): Promise<string | null> {
  // Static first, so the usual outcome is that nothing is executed at all. The
  // probe covers shapes a reader cannot see: a computed key, an assignment built
  // at runtime, a re-export.
  const statik = staticCjsExportNames(bundled)
  const names = statik.length ? statik : await cjsExportNames(path)
  if (!names.length) return null

  if (!statik.length) handlerLog.BUNDLE_CJS_PROBED({ file: path })

  const spec = JSON.stringify(path)
  const shim = [
    `import __cjs from ${spec}`,
    'export default __cjs',
    ...names.map(
      name => `export const ${name} = __cjs[${JSON.stringify(name)}]`,
    ),
    '',
  ].join('\n')

  const shimPath = fs.resolve(
    Bakery.cacheDir,
    'nm_cache',
    `${toHash(path)}.interop.mjs`,
  )
  const [writeErr] = await Try.catch(() => Bun.write(shimPath, shim))
  if (writeErr) return null

  const build = await Bun.build({
    entrypoints: [shimPath],
    target: 'browser',
    format: 'esm',
    minify: Boolean(import.meta.env.PROD),
    define: defines,
  })

  if (!build.success || !build.outputs.length) return null
  return await build.outputs[0].text()
}

export async function bundleModule(
  path: fs.AbsolutePath,
): Promise<CompileResult> {
  const build = await Bun.build({
    entrypoints: [path],
    target: 'browser',
    format: 'esm',
    // Coerced, and not defensively: `Bun.build` *rejects* a non-boolean
    // `minify` with "Expected minify to be a boolean or an object" rather than
    // treating it as truthy, so anything that reaches this line as a string
    // takes the whole bundle down.
    //
    // That is reachable from outside this repo. `PROD` is an accessor on
    // `process.env`, and Bun's `process.env` proxy stringifies on write, so an
    // embedder that assigns the flag at all — even `process.env.PROD = true` —
    // leaves a string behind. The suite's own instance of this is fixed at the
    // source (see `setModeFlag` in `src/tests/fixtures.ts`); this guards the
    // writes we do not own.
    minify: Boolean(import.meta.env.PROD),
    define: await getDefines(),
    // Installed packages stay bare imports and resolve through the import map
    // — which covers every one of them by construction (`initImportMap`). The
    // alternative was measured on `@vue-material/core`: each `/_nm/` bundle
    // inlined its own copy of `vue`, and two Vue instances in one page is
    // broken reactivity, not a size problem. A ref created by one Vue is
    // invisible to another Vue's render effect. Node builtins are not in the
    // list, so Bun still polyfills them.
    external: await installedPackages(),
  })

  if (build.success && build.outputs.length > 0) {
    const content = await build.outputs[0].text()

    // A bundle that cannot possibly work is not a success, whatever `build`
    // says — see `isEmptyExportList`. Repairable in the common case, so try
    // that before refusing.
    if (isEmptyExportList(content)) {
      const repaired = await bundleReExportShim(path, await getDefines())
      if (repaired) {
        handlerLog.BUNDLE_SIDE_EFFECTS_REPAIRED({ file: path })
        return { success: true, content: repaired }
      }

      handlerLog.BUNDLE_EMPTY_EXPORTS({ file: path })
      return { success: false, errors: ['bundle body is empty'] }
    }

    // Only for the shape that breaks, and only after the cheap build has proved
    // it is that shape — so nothing is imported speculatively.
    if (isCjsDefaultOnly(content)) {
      const interop = await bundleCjsWithNamedExports(
        path,
        await getDefines(),
        content,
      )
      if (interop) {
        handlerLog.BUNDLE_CJS_INTEROP({ file: path })
        return { success: true, content: interop }
      }
      handlerLog.BUNDLE_CJS_DEFAULT_ONLY({ file: path })
    }

    return { success: true, content }
  }

  const errors = build.logs
    .map(log => {
      if (!log) return ''
      if (is.string(log)) return log
      const msg = log.message || ''
      const pos = log.position
      if (!pos) return msg

      return `${pos.file || ''}:${pos.line || 0}:${pos.column || 0} - ${msg}`
    })
    .filter(Boolean)

  // `handlerLog.BUNDLE_ERR` was declared and never called, so a bundle that
  // failed was silent here: every caller either swallowed the result
  // (`nm.ts`, `virtual-asset.ts` fall back to serving nothing) or logged its
  // own line, and none of them printed the diagnostics this function had
  // already collected. The 500 the caller returns is not a description.
  handlerLog.BUNDLE_ERR({
    file: path,
    error: errors.join('\n  ') || 'no diagnostics reported',
  })

  return { success: false, errors }
}
