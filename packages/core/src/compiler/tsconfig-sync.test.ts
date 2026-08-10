import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  clearHostConfigCache,
  initConfig,
} from '../core/config'
import { fs } from '../utils/fs'
import {
  coreProjects,
  fromProjectDir,
  mergeRootConfig,
  syncTSConfigPaths,
  writeProjects,
} from './tsconfig-sync'

beforeEach(async () => {
  clearHostConfigCache()
  await initConfig()
})

describe('syncTSConfigPaths', () => {
  test('runs without error', async () => {
    await expect(syncTSConfigPaths()).resolves.toBeUndefined()
  })

  test('is idempotent (no-op on second call)', async () => {
    await syncTSConfigPaths()
    await expect(syncTSConfigPaths()).resolves.toBeUndefined()
  })
})

/**
 * The generated projects live two directories down, in `.cache/tsconfig/`, so
 * every glob has to be rewritten relative to that.
 *
 * **The bug these exist for shipped and passed.** `Bakery.config.root` is an
 * absolute path, not the relative `src` it looks like, so the first version
 * emitted `../../C:/WebDAV/.../src/**` — a glob matching nothing. A project
 * matching nothing typechecks clean, so it reported zero errors and looked
 * perfect; it was caught only by counting the files in the program.
 *
 * That is why these assert on the *shape of the path* rather than on the
 * absence of an error.
 */
describe('fromProjectDir', () => {
  test('an app-relative glob goes up two levels', () => {
    expect(fromProjectDir('src/**/*.ts')).toBe('../../src/**/*.ts')
    expect(fromProjectDir('server.config.ts')).toBe('../../server.config.ts')
    expect(fromProjectDir('./schema.ts')).toBe('../../schema.ts')
  })

  test('an absolute glob is made relative, never prefixed', () => {
    // The exact failure: `../../` glued onto a full path.
    for (const abs of [
      'C:/WebDAV/SHARED/ecr/src/**/*.ts',
      'C:\\WebDAV\\SHARED\\ecr\\src\\**\\*.ts',
      '/home/user/app/src/**/*.ts',
    ]) {
      const out = fromProjectDir(abs)
      expect(out.startsWith('../../C:')).toBe(false)
      expect(out.startsWith('../..//')).toBe(false)
      // A drive letter surviving anywhere but the very start means the path was
      // concatenated rather than resolved.
      expect(/\.\.\/[A-Za-z]:/.test(out)).toBe(false)
    }
  })

  test('the result always looks like a path TypeScript will follow', () => {
    // Relative or explicitly `./`-prefixed; never bare, which TypeScript would
    // resolve against the project directory rather than the app.
    for (const input of ['src/**/*.ts', 'C:/app/src/**/*.ts', './x.ts']) {
      const out = fromProjectDir(input)
      expect(out.startsWith('.') || out.startsWith('/')).toBe(true)
    }
  })
})

/**
 * `importMap` is a **browser** import map: the framework serves it as
 * `<script type="importmap">` and the browser resolves its specifiers. The
 * generator used to copy the `paths` derived from it into *every* project on the
 * reasoning that an alias is app-wide — so a server file could import an alias
 * only the browser can satisfy, and typecheck clean doing it.
 *
 * That is the same failure the server/client split exists to prevent, one level
 * up: `Bun.*` in browser code was the first instance, a browser-only specifier
 * in server code is the second.
 */
describe('importMap paths are scoped to the client project', () => {
  test('only the client project opts in', () => {
    const projects = coreProjects()
    const byName = new Map(projects.map(p => [p.name, p]))

    expect(byName.get('client')?.importMapPaths).toBe(true)
    // Not `toBe(false)`: absent is the default, and asserting the default is
    // literally `false` would fail for the right reason on a plugin project.
    expect(byName.get('server')?.importMapPaths).toBeFalsy()
  })

  test('the generator gates on the flag rather than writing paths always', async () => {
    // The fix is one condition, and losing it puts the aliases back everywhere
    // while every other assertion here still passes.
    const source = await Bun.file(
      fs.resolve(import.meta.dir, 'tsconfig-sync.ts'),
    ).text()
    expect(source).toContain('project.importMapPaths &&')
  })
})

/**
 * The root tsconfig is merged, never replaced.
 *
 * This shipped the other way and broke every `.tsx` page in any app that ran a
 * dev boot. The root was overwritten with a references-only stub on the
 * reasoning that the generated projects carry the JSX options — true for `tsc`,
 * false for **Bun's runtime**, which reads `compilerOptions.jsx*` from the root
 * and does not follow `references`.
 *
 * Measured on a scratch app before the fix: `GET /` answered **200** with
 * `{"type":"html","props":{…},"_owner":null,"_store":{}}` — the automatic JSX
 * runtime's element tree, JSON-encoded because the handler got an object where
 * it expects a `SafeHtml` string. No throw, no log, no 500. After the fix, the
 * same request returns `<h1>Hello</h1>`.
 */
describe('mergeRootConfig', () => {
  const refs = [{ path: './.cache/tsconfig/server.json' }]

  test('keeps every key the developer wrote', () => {
    const written = {
      $comment: 'Keep the three jsx* options.',
      extends: '@bakery-framework/core/tsconfig.server.json',
      compilerOptions: {
        jsx: 'react',
        jsxFactory: 'createElement',
        jsxFragmentFactory: 'Fragment',
      },
      include: ['src/**/*.tsx'],
    }

    const merged = mergeRootConfig(written, refs)

    for (const [key, value] of Object.entries(written)) {
      expect(merged[key]).toEqual(value)
    }
    expect(merged.references).toEqual(refs)
  })

  test('the jsx options survive, because Bun reads them from here', () => {
    // The single assertion the shipped version failed.
    const merged = mergeRootConfig(
      { compilerOptions: { jsxFactory: 'createElement' } },
      refs,
    )
    expect((merged.compilerOptions as any).jsxFactory).toBe('createElement')
  })

  test('does not introduce files: [] — that would make it a solution config', () => {
    // `files: []` plus `references` tells tsc to compile nothing itself. Harmless
    // for tsc, and it was paired with dropping compilerOptions, which was not.
    const merged = mergeRootConfig({ include: ['src/**/*.ts'] }, refs)
    expect(merged.files).toBeUndefined()
    expect(merged.include).toEqual(['src/**/*.ts'])
  })

  test('an app with no root config gets one that works at runtime', () => {
    const merged = mergeRootConfig(null, refs) as any
    expect(merged.compilerOptions.jsx).toBe('react')
    expect(merged.compilerOptions.jsxFactory).toBe('createElement')
    expect(merged.compilerOptions.jsxFragmentFactory).toBe('Fragment')
    expect(merged.references).toEqual(refs)
  })
})

/**
 * The generator end to end: what actually lands in `.cache/tsconfig/`.
 *
 * `writeProjects` only writes that directory — it does not touch the app's root
 * config — so it is safe to call here, and it is the honest place to assert the
 * `importMapPaths` gate. Everything above tests the pieces; this tests the file
 * a developer's editor will read.
 */
describe('writeProjects', () => {
  const PATHS = { '@lib/*': ['lib/*'] }

  /** A plugin shaped like `@bakery-framework/plugin-vue`: browser code, opts in. */
  const browserPlugin = {
    name: 'sfc',
    tsconfig: {
      project: {
        name: 'sfc',
        extends: '@bakery-framework/core/tsconfig.vue.json',
        include: ['src/**/*.sfc'],
        importMapPaths: true,
      },
    },
  }

  /** And one that does not, to prove the default is off rather than unset. */
  const serverPlugin = {
    name: 'jobs',
    tsconfig: {
      project: {
        name: 'jobs',
        extends: '@bakery-framework/core/tsconfig.server.json',
        include: ['jobs/**/*.ts'],
      },
    },
  }

  async function generated(): Promise<Record<string, any>> {
    __setTestConfig({ plugins: [browserPlugin, serverPlugin] as any })
    try {
      const names = await writeProjects(PATHS)
      const out: Record<string, any> = {}
      for (const name of names) {
        const file = fs.resolve(
          process.cwd(),
          '.cache/tsconfig',
          `${name}.json`,
        )
        out[name] = JSON.parse(await Bun.file(file).text())
      }
      return out
    } finally {
      __resetTestConfig()
    }
  }

  test('paths land in the client and opted-in plugin projects only', async () => {
    const projects = await generated()

    expect(Object.keys(projects).sort()).toEqual([
      'client',
      'jobs',
      'server',
      'sfc',
    ])

    // The two that compile browser code.
    expect(projects.client.compilerOptions.paths).toBeDefined()
    expect(projects.sfc.compilerOptions.paths).toBeDefined()

    // The two that do not. An `importMap` alias here would typecheck an import
    // the server cannot resolve — the bug this gate closes.
    expect(projects.server.compilerOptions.paths).toBeUndefined()
    expect(projects.jobs.compilerOptions.paths).toBeUndefined()
  })

  test('the server project keeps its JSX options regardless', async () => {
    const projects = await generated()
    expect(projects.server.compilerOptions.jsxFactory).toBe('createElement')
  })

  test('paths values are rewritten for the two-levels-down location', async () => {
    const projects = await generated()
    // `lib/*` app-relative becomes `../../lib/*`. Unrewritten, the alias would
    // resolve against `.cache/tsconfig/` and silently match nothing.
    expect(projects.client.compilerOptions.paths['@lib/*']).toEqual([
      '../../lib/*',
    ])
  })
})

/** The real vue plugin is the case `importMapPaths` was added for. */
describe('plugin-vue', () => {
  test('opts into importMap paths', async () => {
    const source = await Bun.file(
      fs.resolve(import.meta.dir, '../../../plugins/vue/src/index.ts'),
    ).text()
    expect(source).toContain('importMapPaths: true')
  })
})
