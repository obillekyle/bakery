import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { initConfig } from '../core/config'
import { fs } from '../utils/fs'
import {
  bundleModule,
  compile,
  compileText,
  isCjsDefaultOnly,
  isEmptyExportList,
  staticCjsExportNames,
} from './compiler'

describe('compileText', () => {
  test('transforms TypeScript to JavaScript', async () => {
    const result = await compileText('const x: number = 42')
    expect(result).toContain('42')
    expect(result).not.toContain(': number')
  })

  test('handles plain JavaScript input', async () => {
    const result = await compileText('const x = 42')
    expect(result).toContain('42')
  })

  test('handles empty input', async () => {
    const result = await compileText('')
    expect(typeof result).toBe('string')
  })

  test('preserves JSX-like syntax', async () => {
    const input = 'const count = 42'
    const result = await compileText(input)
    expect(result).toContain('42')
  })
})

/**
 * A compile failure has to survive the trip back to the handler.
 *
 * The pathless branch has always caught the transpiler and logged
 * `COMPILE_SOURCE_FAIL`; the branch *with* a path: the one every `.ts` asset
 * request takes: did not, so the throw escaped `compile()` and unwound past
 * `TSHandler` into the worker's catch-all. The developer got
 * `Unhandled Server Error: Expected identifier but found end of file`: no file,
 * no line, and a body of `An unexpected error occurred.` Meanwhile
 * `TSHandler`'s own `'Compilation Failed'` 500 could never fire, because
 * nothing ever returned to it.
 */
const BROKEN_ROOT = fs.resolve(process.cwd(), '.cache/__compiler-test__')

describe('compileText: a failure with a path in hand', () => {
  test('returns null instead of throwing past the caller', async () => {
    const path = fs.resolve(BROKEN_ROOT, 'broken.ts') as fs.AbsolutePath

    // Not `expect(...).rejects`: the point is that it resolves.
    const result = await compileText('export default function ( {', path)
    expect(result).toBeNull()
  })

  test('a source string with no path still resolves', async () => {
    // Unchanged behavior, pinned so the two branches cannot diverge again:
    // pathless compiles return the original source.
    const result = await compileText('export default function ( {')
    expect(result).toBe('export default function ( {')
  })

  test('compile() of a broken file resolves null rather than throwing', async () => {
    const path = fs.resolve(BROKEN_ROOT, 'page.ts') as fs.AbsolutePath
    await Bun.write(path, 'export const broken: number =\n')

    try {
      expect(await compile(path)).toBeNull()
    } finally {
      await rm(BROKEN_ROOT, { recursive: true, force: true })
    }
  })
})

/**
 * A bundle that is nothing but an export list names bindings that were never
 * declared, so every one of them is a `ReferenceError` the moment the browser
 * evaluates it, and `Bun.build` reports it as `success: true` with zero
 * diagnostics.
 *
 * Found on `@vue-material/core@1.0.0-alpha.28`, whose barrel re-exports ~200
 * symbols from `.vue.js` files and bundles to 3,549 bytes of pure export list;
 * importing it throws `AggregateError: 189 errors`. The strings below are that
 * shape. Serving it is the failure this module fights everywhere else: a 200
 * carrying JavaScript that breaks only in the browser, with an empty server log.
 */
describe('isEmptyExportList', () => {
  test('flags an export list with nothing behind it', () => {
    expect(
      isEmptyExportList('export {\n  toKebabCase,\n  useTheme\n};\n'),
    ).toBe(true)
    // The real shape uses `local as exported` for default re-exports.
    expect(isEmptyExportList('export {\n  default6 as Card,\n  $\n};\n')).toBe(
      true,
    )
  })

  test('leaves a bundle that has real code alone', () => {
    expect(
      isEmptyExportList('var total = 1 + 1;\nexport {\n  total\n};\n'),
    ).toBe(false)
    expect(isEmptyExportList('export default 42\n')).toBe(false)
    expect(isEmptyExportList('import x from "y";\nexport {\n  x\n};\n')).toBe(
      false,
    )
  })

  test('an empty module is legal and is not flagged', () => {
    // `export {}` declares nothing, so there is no undefined binding to hit.
    expect(isEmptyExportList('export {};\n')).toBe(false)
    expect(isEmptyExportList('export {}')).toBe(false)
    expect(isEmptyExportList('')).toBe(false)
  })
})

/**
 * The repair for the `sideEffects` tree-shake described on `isEmptyExportList`.
 *
 * The fixture is a real package in a real `node_modules`, because the bug keys
 * on the entry being *inside* a package whose manifest declares
 * `sideEffects: false`, nothing reproduces it from a loose file. `sideEffects`
 * is the only difference between the two packages below, which is what makes
 * this a test of the mechanism rather than of one broken library.
 */
describe('bundleModule repairs a sideEffects tree-shake', () => {
  const ROOT = fs.resolve(fs.cwd, '.cache', '__side-effects-test__')
  const NM = `${ROOT}/node_modules`

  async function writePackage(name: string, sideEffects?: boolean) {
    const dir = `${NM}/${name}`
    const manifest: Record<string, unknown> = {
      name,
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }
    if (sideEffects !== undefined) manifest.sideEffects = sideEffects

    await Bun.write(`${dir}/package.json`, JSON.stringify(manifest))
    await Bun.write(`${dir}/leaf.js`, 'export const shippingTotal = 42\n')
    await Bun.write(
      `${dir}/index.js`,
      "export { shippingTotal } from './leaf.js'\n",
    )
    return `${dir}/index.js` as fs.AbsolutePath
  }

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
  })

  test('a sideEffects:false barrel is served with its code, not as a husk', async () => {
    const entry = await writePackage('shaken-pkg', false)

    // **Bun fixed this in 1.4.1, and the assertion that used to live here is
    // what told us.** It read
    //
    //     expect(isEmptyExportList(await raw.outputs[0].text())).toBe(true)
    //
    // with a note saying that if Bun ever stopped producing the husk, this
    // test must fail rather than quietly assert nothing. On 2026-09-19 it
    // failed, on `bun latest`, on both CI platforms, and re-running the last
    // green commit unchanged against the same Bun failed identically, which is
    // what proved it was the runtime rather than the branch. 1.4.1's notes name
    // it: "an entry that only re-exports emitted `export { a }` with no
    // declaration".
    //
    // So the premise is a *branch* now rather than an assertion. It is not
    // simply deleted, because `engines.bun` is `>=1.4.0` and CI pins a 1.4.0
    // job: the husk still appears there, and `bundleReExportShim` is still the
    // only thing that makes those installs work. The repair becomes deletable
    // when that floor moves above 1.4.0, not before.
    //
    // What is asserted in both regimes is the thing that actually matters:
    // `bundleModule` hands back the code either way.
    const raw = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'esm',
    })
    expect(raw.success).toBe(true)
    const shaken = isEmptyExportList(await raw.outputs[0].text())

    const result = await bundleModule(entry)
    expect(result.success).toBe(true)
    expect(result.content).toContain('42')
    expect(isEmptyExportList(result.content ?? '')).toBe(false)

    if (shaken) {
      // The old regime: Bun emptied it and the repair filled it back in. The
      // two assertions above are then a statement about `bundleReExportShim`.
      expect(result.content).not.toBe(await raw.outputs[0].text())
    }
  })

  test('the detector still recognizes the husk Bun used to emit', () => {
    // The repair is dormant on a fixed Bun, so this keeps the half that
    // decides whether to run it honest. The literal is the shape 1.4.0
    // produced for the fixture above: an export list with nothing behind it.
    expect(isEmptyExportList('export {\n  shippingTotal\n};\n')).toBe(true)
    expect(
      isEmptyExportList('var shippingTotal = 42;\nexport {\n  shippingTotal\n};\n'),
    ).toBe(false)
  })

  test('the same package without the flag was never broken', async () => {
    const entry = await writePackage('plain-pkg')

    const result = await bundleModule(entry)
    expect(result.success).toBe(true)
    expect(result.content).toContain('42')
  })
})

/**
 * `compileText` does not rewrite imports, at all. It used to append `/index`
 * to a relative import whose target was a directory, which was a regular
 * expression over transpiled JavaScript: the same class that once rewrote
 * bare specifiers inside string literals, corrupting user data. Both halves
 * of its removal are pinned: the handler resolves directory imports in every
 * spelling (`ts.test.ts`), and the corruption case below fails against the
 * old code, because `./lib` really is a directory next to the file.
 */
describe('compileText leaves imports exactly as written', () => {
  // PluginHooks.onCompile reads the config.
  beforeAll(() => initConfig())

  const IMPORT_ROOT = fs.resolve(fs.cwd, '.cache', '__import-rewrite-test__')

  test('a string literal that looks like an import is data, not code', async () => {
    await Bun.write(`${IMPORT_ROOT}/lib/index.ts`, 'export const x = 1\n')
    const path = `${IMPORT_ROOT}/page.ts` as fs.AbsolutePath

    const source = [
      "import { x } from './lib'",
      `const docs = "usage: import { x } from './lib'"`,
      'export default { x, docs }',
    ].join('\n')

    const result = await compileText(source, path)
    expect(result).not.toBeNull()
    // Neither the real import nor the lookalike inside the string moved.
    expect(result).not.toContain('./lib/index')
    expect(result).toContain(`from './lib'`)
    await rm(IMPORT_ROOT, { recursive: true, force: true })
  })
})

/**
 * The CJS interop chain, in-repo. It was verified end to end against a
 * scratch app when it was built, but nothing in the suite exercised it: the
 * static lexer, the subprocess probe, and the interop shim were all at 0%
 * coverage. These fixtures are the measured shapes from that session.
 */
describe('CJS interop', () => {
  const CJS_ROOT = fs.resolve(fs.cwd, '.cache', '__cjs-interop-test__')
  const NM = `${CJS_ROOT}/node_modules`

  beforeAll(async () => {
    await initConfig()
    // The static shape: a whole-object assignment the lexer can read.
    await Bun.write(
      `${NM}/ledger-pkg/package.json`,
      JSON.stringify({
        name: 'ledger-pkg',
        version: '1.0.0',
        main: './index.js',
      }),
    )
    await Bun.write(
      `${NM}/ledger-pkg/index.js`,
      [
        'function openLedger() { return 12 }',
        'function closeLedger() { return 0 }',
        'module.exports = { openLedger, closeLedger }',
        '',
      ].join('\n'),
    )
    // The dynamic shape: keys built at runtime, invisible to any reader.
    await Bun.write(
      `${NM}/dyn-pkg/package.json`,
      JSON.stringify({ name: 'dyn-pkg', version: '1.0.0', main: './index.js' }),
    )
    await Bun.write(
      `${NM}/dyn-pkg/index.js`,
      [
        'const out = {}',
        "for (const k of ['alpha', 'beta']) out[k] = () => k",
        'module.exports = out',
        '',
      ].join('\n'),
    )
  })

  afterAll(async () => {
    await rm(CJS_ROOT, { recursive: true, force: true })
  })

  test('isCjsDefaultOnly recognizes the broken shape and only it', async () => {
    const cjs = await Bun.build({
      entrypoints: [`${NM}/ledger-pkg/index.js`],
      target: 'browser',
      format: 'esm',
    })
    expect(isCjsDefaultOnly(await cjs.outputs[0].text())).toBe(true)

    // Plain ESM with named exports is not the shape.
    expect(isCjsDefaultOnly('export const x = 1\nexport { x }')).toBe(false)
  })

  test('the static lexer reads the object literal without executing', async () => {
    const build = await Bun.build({
      entrypoints: [`${NM}/ledger-pkg/index.js`],
      target: 'browser',
      format: 'esm',
    })
    const names = staticCjsExportNames(await build.outputs[0].text())
    expect(names.sort()).toEqual(['closeLedger', 'openLedger'])
  })

  test('the lexer declines what it cannot read, instead of guessing', async () => {
    const build = await Bun.build({
      entrypoints: [`${NM}/dyn-pkg/index.js`],
      target: 'browser',
      format: 'esm',
    })
    // Keys built in a loop: no object literal to read.
    expect(staticCjsExportNames(await build.outputs[0].text())).toEqual([])
  })

  test('bundleModule serves real named exports for the static shape', async () => {
    const result = await bundleModule(
      `${NM}/ledger-pkg/index.js` as fs.AbsolutePath,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('openLedger')
    expect(result.content).toMatch(/export\s*(const|\{)[\s\S]*openLedger/)
  })

  /**
   * The interop has to fire in PROD too, and it did not, for as long as the
   * wrapper check was `content.includes('__commonJS')`: minification
   * renames the helper, so named imports of CJS packages worked all through
   * dev and broke only in the deployed app. Found by an ordering flake: a
   * handlers test left PROD set and the static-shape test above met a
   * minified bundle for the first time.
   */
  test('the interop fires under PROD minification too', async () => {
    const { asProd } = await import('../tests/fixtures')

    const result = await asProd(() =>
      bundleModule(`${NM}/ledger-pkg/index.js` as fs.AbsolutePath),
    )

    expect(result.success).toBe(true)
    // Minified or not, the module must offer the named binding.
    expect(result.content).toContain('openLedger')
    expect(result.content).toMatch(/export{|export {|export const/)
  })

  test('the dynamic shape falls back to the probe and still gets its names', async () => {
    const result = await bundleModule(
      `${NM}/dyn-pkg/index.js` as fs.AbsolutePath,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('alpha')
    expect(result.content).toContain('beta')
  })
})
