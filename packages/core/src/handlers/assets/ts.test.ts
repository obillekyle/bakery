import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../../core/config'
import { fs } from '../../utils/fs'
import { TSHandler } from './ts'

const ROOT = fs.resolve(process.cwd(), '.cache/__ts-test__')
const PAGE = fs.resolve(ROOT, 'page.ts')
const BROKEN = fs.resolve(ROOT, 'broken.ts')

/**
 * Overrides the compile seam, for the failure modes that are not a syntax
 * error: a plugin's `onCompile` returning null, say.
 */
class NullCompileHandler extends TSHandler {
  static get cacheDir() {
    return fs.resolve(ROOT, '.cache')
  }

  static compileRoute(): Promise<string | null> {
    return Promise.resolve(null)
  }
}

/** The real compiler, against a real file, in this test's own cache dir. */
class RealCompileHandler extends TSHandler {
  static get cacheDir() {
    return fs.resolve(ROOT, '.cache-real')
  }
}

beforeAll(async () => {
  await initConfig()
  await Bun.write(PAGE, 'export const x = 1\n')
  await Bun.write(BROKEN, 'export const broken: number =\n')
  __setTestConfig({ root: ROOT })
})

afterAll(async () => {
  __resetTestConfig()
  await rm(ROOT, { recursive: true, force: true })
})

describe('TSHandler.handle', () => {
  test('a failed compile is a 500, not a 404', async () => {
    // The route exists — the server failed to build it. Serving that as 404
    // told the developer the file was missing.
    const res = await NullCompileHandler.handle('/page.js')

    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(500)
    expect(await (res as Response).text()).toBe('Compilation Failed: page.ts')
  })

  test('a genuinely missing route is still a 404', async () => {
    const res = await NullCompileHandler.handle('/does-not-exist.js')

    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(404)
  })

  test('a syntax error is a 500 from here, not a throw past the handler', async () => {
    // The measured blackout: the transpiler threw out of `compile()` and
    // unwound all the way to the worker, so this branch never ran and the log
    // said `Unhandled Server Error: Unexpected end of file` — no file, no
    // line. `compileText` now catches with the path in hand, logs
    // `compLog.COMPILE_FAIL`, and returns null so the 500 comes from here.
    const res = await RealCompileHandler.handle('/broken.js')

    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(500)
    expect(await (res as Response).text()).toBe('Compilation Failed: broken.ts')
  })

  test('a file that compiles is still served', async () => {
    const res = await RealCompileHandler.handle('/page.js')

    // A BunFile from the cache, not a Response — the success path must not
    // have been disturbed by the failure path.
    expect(res).not.toBeInstanceOf(Response)
    expect(await (res as Bun.BunFile).size).toBeGreaterThan(0)
  })
})

/**
 * Directory imports resolve server-side, in every spelling the browser can
 * produce — which is what made `compileText`'s `/index`-appending rewrite
 * removable. That rewrite was a regex over transpiled JavaScript, the same
 * class that once rewrote string literals that merely looked like imports;
 * these pins are the load-bearing half of its removal.
 */
describe('directory imports resolve to their index', () => {
  const DIRS = fs.resolve(ROOT, 'dirs')

  class DirHandler extends TSHandler {
    static get cacheDir() {
      return fs.resolve(DIRS, '.cache')
    }
    static get config() {
      return { ext: ['ts'], dir: DIRS }
    }
  }

  beforeAll(async () => {
    await Bun.write(`${DIRS}/lib/index.ts`, 'export const shelf = 7\n')
    await Bun.write(`${DIRS}/deep/nested/index.ts`, 'export const bin = 9\n')
  })

  for (const path of ['/lib', '/lib.js', '/deep/nested', '/deep/nested.js']) {
    test(`${path} serves the compiled index`, async () => {
      const res = await DirHandler.handle(path)
      const body =
        res instanceof Response
          ? await res.text()
          : await (res as Bun.BunFile).text()
      expect(body).toContain(path.includes('lib') ? 'shelf' : 'bin')
    })
  }
})
