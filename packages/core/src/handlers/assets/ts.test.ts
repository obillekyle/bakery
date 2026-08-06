import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../../core/config'
import { fs } from '../../utils/fs'
import { TSHandler } from './ts'

const ROOT = fs.resolve(process.cwd(), '.bakery/cache/__ts-test__')
const PAGE = fs.resolve(ROOT, 'page.ts')

/**
 * Overrides the compile seam rather than planting a file whose compile fails:
 * a syntax error makes the transpiler *throw* (which propagates to the error
 * registry on its own), while the `'Compilation Failed'` branch fires when the
 * compiler yields nothing — e.g. a plugin's `onCompile` returning null.
 */
class NullCompileHandler extends TSHandler {
  static get cacheDir() {
    return fs.resolve(ROOT, '.cache')
  }

  static compileRoute(): Promise<string | null> {
    return Promise.resolve(null)
  }
}

beforeAll(async () => {
  await initConfig()
  await Bun.write(PAGE, 'export const x = 1\n')
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
    expect(await (res as Response).text()).toBe('Compilation Failed')
  })

  test('a genuinely missing route is still a 404', async () => {
    const res = await NullCompileHandler.handle('/does-not-exist.js')

    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(404)
  })
})
