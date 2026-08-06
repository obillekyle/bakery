import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { __resetTestConfig, __setTestConfig, initConfig } from '../core/config'
import { fs } from '../utils'
import { ApiHandler } from '../handlers/routes/api'
import { TSHandler } from '../handlers/assets/ts'

/**
 * The blocked globs are matched against the *request path*, but `routeGlobs`
 * deliberately resolves a request to a file with a different extension: a
 * request for `/schema.css` is answered by `schema.ts` (stem + the handler's
 * own extension), and `/schema` by the same. So the deny-list was asked about
 * a string that names no file, said "not blocked", and `TSHandler` compiled
 * and served the file the list exists to protect — verified against a live
 * server: `/schema.ts` 403, `/schema.js` 200 with the file's contents.
 *
 * The check therefore has to run against the file that was *resolved*, not
 * only the path that was requested.
 */

const ROOT = fs.resolve(process.cwd(), '.bakery/cache/__blocked-res__')
const blocked = new Bun.Glob('{**/schema.ts,**/*.env}')

beforeAll(async () => {
  await initConfig()
  await Bun.write(`${ROOT}/schema.ts`, 'export const SECRET = "leak"\n')
  await Bun.write(`${ROOT}/page.ts`, 'export const ok = 1\n')
  await Bun.write(`${ROOT}/api/schema.ts`, 'export default () => ({ ok: 1 })\n')
})

afterAll(async () => {
  __resetTestConfig()
  await rm(ROOT, { recursive: true, force: true })
})

describe('blocked globs apply to the resolved file, not just the request path', () => {
  beforeAll(() => {
    __setTestConfig({ root: ROOT, blocked } as any)
  })

  test('the extension the client asked for cannot launder a blocked file', async () => {
    // Every one of these resolves to `schema.ts` through stem+ext substitution.
    for (const request of ['/schema.css', '/schema.js', '/schema.txt']) {
      expect(await TSHandler.resolveRoute(request)).toBeNull()
    }
  })

  test('the extensionless form cannot either', async () => {
    expect(await TSHandler.resolveRoute('/schema')).toBeNull()
  })

  test('the direct request stays refused', async () => {
    expect(await TSHandler.resolveRoute('/schema.ts')).toBeNull()
  })

  test('an unblocked file still resolves', async () => {
    const info = await TSHandler.resolveRoute('/page.ts')
    expect(info).not.toBeNull()
    expect(info!.path).toBe('page.ts')
  })

  test('a route-only handler stays exempt — it serves names, not file bytes', async () => {
    // ApiHandler executes a module and returns its value; it never hands back
    // file contents, which is why `/api/manifest.json` must not 403. That
    // exemption has to survive this fix.
    // `ApiHandler.resolveRoute` strips the `/api` prefix itself.
    const info = await ApiHandler.resolveRoute('/api/schema')
    expect(info).not.toBeNull()
    expect(info!.path).toBe('schema.ts')
  })
})
