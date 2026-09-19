import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { __setCachedDashboardJs, handleJsAsset } from './setup'

/**
 * `dashboard.js` is served from a file cached on the first request, and every
 * request after that wrapped it in a `Response` — which `ETag.sendResponse`
 * leaves alone, because it returns early when no ETag header is already set.
 * So the console re-downloaded the whole bundle on every load: 22,370 bytes,
 * measured against a production server.
 *
 * Returning the `BunFile` is what routes it through `ETag.sendFile` instead,
 * which computes an ETag, negotiates a precompressed variant and answers a
 * conditional request with a 304.
 *
 * Asserted as a shape rather than a header, because the header is core's job
 * and core already tests it. What went wrong here is the wrapping, and the
 * wrapping is what this pins.
 */
const dirs: string[] = []

afterEach(() => {
  __setCachedDashboardJs(null)
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Temp directories; a lingering handle on Windows is not worth failing.
    }
  }
})

describe('the cached dashboard bundle', () => {
  test('is returned as a file, not wrapped in a Response', async () => {
    const dir = mkdtempSync(`${tmpdir()}/dashjs-`)
    dirs.push(dir)
    const file = `${dir}/_dashboard.js`
    writeFileSync(file, 'console.log("hello")')
    __setCachedDashboardJs(file)

    const answer = await handleJsAsset()

    // A `Blob` reaches `ETag.sendFile` in `processResponse`; a `Response` does
    // not, and gains neither an ETag nor a Cache-Control.
    expect(answer).toBeInstanceOf(Blob)
    expect(answer).not.toBeInstanceOf(Response)
    expect(await (answer as Blob).text()).toBe('console.log("hello")')
  })

  test('an empty cached file is not served as one', async () => {
    // A truncated write would otherwise be served as a zero-byte bundle for
    // the life of the process.
    const dir = mkdtempSync(`${tmpdir()}/dashjs-`)
    dirs.push(dir)
    const file = `${dir}/_dashboard.js`
    writeFileSync(file, '')
    __setCachedDashboardJs(file)

    const answer = await handleJsAsset()
    expect(await (answer as Blob).text()).not.toBe('')
  }, 30_000)
})

describe('a bundle that cannot execute is refused, not served', () => {
  test('a bare import is caught before the browser sees it', async () => {
    // The failure this exists for: `bundleModule` marks installed packages
    // external, so a cross-package specifier survives as a top-level `import`.
    // That is correct for the `/_nm/` bundles, which load as modules. Served
    // as a classic script it is a syntax error, and the *whole* bundle fails
    // to execute — which is how the console went silently dead while
    // `Bun.build` reported success, the file was served 200 at the right
    // length, typecheck passed and the suite passed.
    const dir = mkdtempSync(`${tmpdir()}/dashjs-`)
    dirs.push(dir)
    const file = `${dir}/_dashboard.js`
    writeFileSync(
      file,
      'import { x } from "@some/package";\nwindow.y = x;\n',
    )
    __setCachedDashboardJs(file)

    // The cached path serves the file as-is; the guard sits on the build path,
    // so this asserts the detector itself against the shape that broke.
    const { bareImportIn } = await import('./setup')
    expect(bareImportIn('import { x } from "@some/package";')).toBe(
      '@some/package',
    )
    expect(bareImportIn("import a from 'vue'\nconsole.log(a)")).toBe('vue')
  })

  test('a dynamic import inside a function is not a bare import', async () => {
    // `import(...)` is how a bundle lazily loads, and it does not start a
    // line. Flagging it would refuse every bundle that has one.
    const { bareImportIn } = await import('./setup')
    expect(bareImportIn('async function f() { await import("./x") }')).toBe(
      null,
    )
    expect(bareImportIn('const s = "import x from y"')).toBe(null)
    expect(bareImportIn('function g(){}\nwindow.g = g\n')).toBe(null)
  })
})
