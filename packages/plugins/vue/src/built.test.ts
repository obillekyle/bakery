import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
// For its side effect, first: the mode flags this file swaps are installed
// by init, and a flag captured before it would be restored to nothing.
import '@bakery-framework/core/core/init'
import { initConfig } from '@bakery-framework/core/core/config'
import {
  BUILD_FORMAT,
  type BuildManifest,
  buildFingerprint,
  layoutsUnder,
  loadBuild,
  moduleServerData,
  staleReason,
} from './built'
import { withProdFlag } from './tests/mode-flag'
import { initVueVersion, VUE_VERSION } from './utils'

/**
 * What a production server reads of `bakery --build`, and when it stops
 * trusting it. The served half is asserted end to end in
 * `tests/vue-build-serves.test.ts`; these pin the decisions one at a time.
 */

let root = ''

beforeAll(async () => {
  await initConfig()
  initVueVersion()
  root = mkdtempSync(`${tmpdir()}/bakery-built-`).replace(/\\/g, '/')
  mkdirSync(`${root}/admin`, { recursive: true })
  writeFileSync(`${root}/page.vue`, '<template><p /></template>')
  writeFileSync(`${root}/admin/layout.vue`, '<template><slot /></template>')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function manifest(): Promise<BuildManifest> {
  return {
    format: BUILD_FORMAT,
    vue: VUE_VERSION,
    fingerprint: buildFingerprint(),
    inputs: { [`${root}/page.vue`]: Bun.file(`${root}/page.vue`).lastModified },
    layouts: { [root]: await layoutsUnder(root) },
    files: [],
    roots: {},
  }
}

describe('when a build stops describing the app', () => {
  test('a build made against these files still does', async () => {
    expect(await staleReason(await manifest())).toBeNull()
  })

  test('another format, another Vue, or other options do not', async () => {
    expect(
      await staleReason({ ...(await manifest()), format: BUILD_FORMAT + 1 }),
    ).toContain('another version of the plugin')
    expect(
      await staleReason({ ...(await manifest()), vue: '3.0.0' }),
    ).toContain('compiled for Vue 3.0.0')
    expect(
      await staleReason({ ...(await manifest()), fingerprint: 'other' }),
    ).toContain('options or the import map')
  })

  test('a file the build read that changed or went does not', async () => {
    const built = await manifest()
    const later = new Date(Date.now() + 60_000)
    utimesSync(`${root}/page.vue`, later, later)
    expect(await staleReason(built)).toContain('page.vue changed')

    expect(
      await staleReason({
        ...built,
        inputs: { [`${root}/gone.vue`]: 1 },
      }),
    ).toContain('gone.vue is gone')
  })

  test('a layout added since does not, though the build read no file of it', async () => {
    const built = await manifest()
    mkdirSync(`${root}/reports`, { recursive: true })
    writeFileSync(`${root}/reports/layout.vue`, '<template><slot /></template>')
    try {
      expect(await staleReason(built)).toContain(
        'a layout.vue was added or removed',
      )
    } finally {
      rmSync(`${root}/reports`, { recursive: true, force: true })
    }
  })
})

describe('loadBuild', () => {
  test('is null in development, whatever is on disk', async () => {
    await withProdFlag(false, async () => {
      expect(await loadBuild()).toBeNull()
    })
  })
})

describe("a bundled component's server data", () => {
  const read = (routePath: string, modules: unknown) =>
    new Function('globalThis', `return ${moduleServerData(routePath)}`)({
      __vue_server_modules: modules,
    })

  test('is its entry in the page, keyed by route path', () => {
    expect(read('/a.vue', { '/a.vue': { total: 3 } })).toEqual({ total: 3 })
  })

  test('is empty when the page carries none', () => {
    expect(read('/a.vue', undefined)).toEqual({})
  })

  test('throws, naming the component and the status, when its block answered with a response', () => {
    expect(() =>
      read('/a.vue', { '/a.vue': { __bakeryResponse: 401 } }),
    ).toThrow(
      '/a.vue: its <script server> block answered with a response, not data: HTTP 401',
    )
  })
})
