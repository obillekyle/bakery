import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { initConfig } from '../../core/config'
import { fs } from '../../utils'
import { TSXHandler } from '../assets/tsx'
import { clearMounts, getMounts, mountRoutes, resolveMount } from './$mounts'

/**
 * A stand-in for a plugin's own directory, outside the app's serve root.
 */
const PLUGIN_DIR = fs.resolve(process.cwd(), '.cache/__mount-test__')

beforeAll(async () => {
  await initConfig()
  await Bun.write(
    `${PLUGIN_DIR}/panel.tsx`,
    'export default function Panel() { return <div>panel</div> }\n',
  )
  await Bun.write(
    `${PLUGIN_DIR}/nested/deep.tsx`,
    'export default () => null\n',
  )
})

afterAll(async () => {
  clearMounts()
  await rm(PLUGIN_DIR, { recursive: true, force: true })
})

describe('route mounts', () => {
  test('resolves a path under a mounted prefix, stripping it', () => {
    clearMounts()
    mountRoutes('/_demo', PLUGIN_DIR)

    const hit = resolveMount('/_demo/panel')
    expect(hit).not.toBeNull()
    expect(hit!.rest).toBe('panel')
    expect(hit!.mount.dir).toBe(PLUGIN_DIR)
  })

  test('the bare prefix resolves with an empty remainder', () => {
    clearMounts()
    mountRoutes('/_demo', PLUGIN_DIR)
    expect(resolveMount('/_demo')?.rest).toBe('')
  })

  test('matches only on a segment boundary', () => {
    clearMounts()
    mountRoutes('/_dash', PLUGIN_DIR)
    // '/_dashboard' must not be captured by the '/_dash' mount.
    expect(resolveMount('/_dashboard/x')).toBeNull()
    expect(resolveMount('/_dash/x')).not.toBeNull()
  })

  test('longest prefix wins for nested mounts', () => {
    clearMounts()
    mountRoutes('/_a', PLUGIN_DIR)
    mountRoutes('/_a/inner', `${PLUGIN_DIR}/nested`)

    expect(resolveMount('/_a/inner/deep')?.mount.prefix).toBe('/_a/inner')
    expect(resolveMount('/_a/other')?.mount.prefix).toBe('/_a')
  })

  test('re-registering a prefix replaces it rather than duplicating', () => {
    clearMounts()
    mountRoutes('/_demo', PLUGIN_DIR)
    mountRoutes('/_demo', `${PLUGIN_DIR}/nested`)

    expect(getMounts().filter(m => m.prefix === '/_demo')).toHaveLength(1)
    expect(resolveMount('/_demo/x')?.mount.dir).toBe(`${PLUGIN_DIR}/nested`)
  })

  test('an unmounted path is unaffected', () => {
    clearMounts()
    mountRoutes('/_demo', PLUGIN_DIR)
    expect(resolveMount('/about')).toBeNull()
  })

  test('normalises a prefix given without a leading slash', () => {
    clearMounts()
    mountRoutes('_demo', PLUGIN_DIR)
    expect(resolveMount('/_demo/panel')?.rest).toBe('panel')
  })

  test('a real handler resolves a file from the mounted directory', async () => {
    clearMounts()
    mountRoutes('/_demo', PLUGIN_DIR)

    // The file lives outside Bakery.serveRoot entirely; without the mount the
    // handler could not see it.
    const info = await TSXHandler.resolveRoute('/_demo/panel')
    expect(info).not.toBeNull()
    expect(info!.filePath.replace(/\\/g, '/')).toContain(
      '__mount-test__/panel.tsx',
    )
  })

  test('containment still applies inside a mount', async () => {
    clearMounts()
    mountRoutes('/_demo', PLUGIN_DIR)
    // Traversal above the mount directory must not resolve.
    const escaped = await TSXHandler.resolveRoute(
      '/_demo/../../../package.json',
    )
    expect(escaped).toBeNull()
  })
})
