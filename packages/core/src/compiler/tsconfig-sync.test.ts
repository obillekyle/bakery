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
  defaultRootConfig,
  fromProjectDir,
  stripGeneratedReferences,
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

  /**
   * The inputs are **per platform**, and the first version of this was not.
   *
   * A Windows drive path is only absolute on Windows. On Linux, `C:/…` has no
   * leading slash, so `path.relative` resolves it against the cwd and returns
   * exactly the `../../C:/…` shape this test forbids — which is correct
   * behaviour for a nonsense input and a red CI job. These globs come from
   * `Bakery.config.root`, produced by the OS the process is running on, so a
   * drive letter cannot reach a Linux host in the first place.
   *
   * Passed on Windows and failed on Linux for as long as it existed, and only
   * met a Linux runner when the branch was first pushed.
   */
  const ABSOLUTE =
    process.platform === 'win32'
      ? [
          'C:/WebDAV/SHARED/ecr/src/**/*.ts',
          'C:\\WebDAV\\SHARED\\ecr\\src\\**\\*.ts',
        ]
      : ['/home/user/app/src/**/*.ts', '/var/www/app/src/**/*.tsx']

  test('an absolute glob is made relative, never prefixed', () => {
    for (const abs of ABSOLUTE) {
      const out = fromProjectDir(abs)
      // The exact failure: `../../` glued onto a full path.
      expect(out.startsWith('../../C:')).toBe(false)
      expect(out.startsWith('../..//')).toBe(false)
      // A drive letter surviving anywhere but the very start means the path was
      // concatenated rather than resolved.
      expect(/\.\.\/[A-Za-z]:/.test(out)).toBe(false)
      // Deliberately *not* asserting that `out` no longer contains `abs`. On
      // POSIX the two share no prefix beyond `/`, so relativising `/home/user/x`
      // correctly yields `../../../../../home/user/x` — which contains it. That
      // assertion passes on Windows and fails on Linux, which is the same trap
      // this block was rewritten to remove.
    }
  })

  test('the result always looks like a path TypeScript will follow', () => {
    // Relative or explicitly `./`-prefixed; never bare, which TypeScript would
    // resolve against the project directory rather than the app.
    for (const input of ['src/**/*.ts', ...ABSOLUTE, './x.ts']) {
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
 * The root tsconfig gains no `references`, and loses the ones a previous
 * release wrote.
 *
 * The generator used to add `references` pointing at the generated projects,
 * and that broke `tsc -p <app>` for every consumer who had booted once.
 * Measured on TypeScript 6.0.3, and none of it depends on include overlap:
 *
 * - TS6306 ("must have setting composite") and TS6310 ("may not disable
 *   emit") fire for every referenced unbuilt `noEmit` project whenever the
 *   referencing program has input files — a referenced project with a
 *   disjoint include fails identically, and so does one matching zero files.
 * - TS6305 ("output file has not been built from source file") fires once per
 *   root file the referenced project also claims — `src/**`,
 *   `server.config.ts`, every `.tsx` page.
 *
 * So no include shape fixes it and no reference shape survives `tsc -p`; the
 * fix is that the generator writes no references at all and strips the ones
 * earlier releases left in tracked tsconfigs.
 */
describe('stripGeneratedReferences', () => {
  const OURS = [
    { path: './.cache/tsconfig/server.json' },
    { path: './.cache/tsconfig/client.json' },
  ]

  test('removes exactly the entries the generator wrote', () => {
    const repaired = stripGeneratedReferences({
      include: ['src/**/*.ts'],
      references: [...OURS, { path: '../shared' }],
    })

    // The developer's own project reference survives; ours do not.
    expect(repaired?.references).toEqual([{ path: '../shared' }])
    expect(repaired?.include).toEqual(['src/**/*.ts'])
  })

  test('every spelling of the generated path is recognised', () => {
    for (const path of [
      './.cache/tsconfig/server.json',
      '.cache/tsconfig/server.json',
      '.\\.cache\\tsconfig\\vue.json',
    ]) {
      const repaired = stripGeneratedReferences({ references: [{ path }] })
      // Repaired (not null), and the key is gone because we wrote every entry.
      expect(repaired).not.toBeNull()
      expect(repaired && 'references' in repaired).toBe(false)
    }
  })

  test('returns null when there is nothing to repair', () => {
    // No write happens on null, so a clean root never dirties git on boot.
    expect(stripGeneratedReferences({ include: ['src/**/*.ts'] })).toBeNull()
    expect(
      stripGeneratedReferences({ references: [{ path: '../shared' }] }),
    ).toBeNull()
    // A malformed key is the developer's to deal with, not ours to rewrite.
    expect(stripGeneratedReferences({ references: 'nonsense' })).toBeNull()
  })

  test('keeps every other key the developer wrote', () => {
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

    const repaired = stripGeneratedReferences({
      ...written,
      references: OURS,
    })

    for (const [key, value] of Object.entries(written)) {
      expect(repaired?.[key]).toEqual(value)
    }
    // The jsx options in particular: Bun's runtime reads them from the root
    // and nowhere else, which is the lesson the replace-not-merge bug taught.
    expect((repaired?.compilerOptions as any).jsxFactory).toBe('createElement')
    // And no files: [] — that would turn the root into a solution config.
    expect(repaired?.files).toBeUndefined()
  })
})

/**
 * An app with no root config still gets one that works at runtime — Bun reads
 * `compilerOptions.jsx*` from the root `tsconfig.json` and does not follow
 * `extends` into a package specifier, so the file must carry the options
 * inline. What it must NOT carry any more is `references`.
 */
describe('defaultRootConfig', () => {
  test('carries the runtime JSX options and no references', () => {
    const config = defaultRootConfig() as any
    expect(config.compilerOptions.jsx).toBe('react')
    expect(config.compilerOptions.jsxFactory).toBe('createElement')
    expect(config.compilerOptions.jsxFragmentFactory).toBe('Fragment')
    expect('references' in config).toBe(false)
  })
})

/**
 * The generator writes no `references` — asserted on the source the way the
 * `importMapPaths` gate is, because every pure-function test above would still
 * pass if `syncTSConfigProjects` grew the old wiring back.
 */
describe('the generator never wires the projects into the root config', () => {
  test('the reference-building line stays gone, the repair stays called', async () => {
    const source = await Bun.file(
      fs.resolve(import.meta.dir, 'tsconfig-sync.ts'),
    ).text()
    // The exact construction the old generator used.
    expect(source).not.toContain('path: `./.cache/tsconfig/')
    expect(source).toContain('stripGeneratedReferences(current)')
  })
})

/**
 * The shipped apps carry the repaired shape. This is the assertion that bites
 * at the artifact level: it fails against any tree where a boot re-added the
 * references — which is exactly the file a consumer's `tsc -p .` reads, and
 * how `bunx tsc -p apps/example` came to fail with ten TS6305s plus a
 * TS6306/TS6310 pair per referenced project.
 */
describe('shipped app tsconfigs reference no generated projects', () => {
  for (const rel of [
    'apps/example/tsconfig.json',
    'apps/starter/tsconfig.json',
  ]) {
    test(rel, async () => {
      const abs = fs.resolve(import.meta.dir, '../../../..', rel)
      const config = (await Bun.file(abs).json()) as Record<string, unknown>
      // null means "nothing to repair" — the committed file is already the
      // shape the generator now maintains.
      expect(stripGeneratedReferences(config)).toBeNull()
    })
  }
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

/**
 * A project that declares `files` keeps the base's ambients.
 *
 * TypeScript's rule is that a child's `files` *replaces* the parent's, and it
 * quietly disarmed every project a plugin contributes.
 * `@bakery-framework/plugin-vue` declares one entry for its `vue.d.ts`, which
 * replaced `tsconfig.vue.json`'s list of core's three ambient declarations.
 *
 * Measured on a real Vue app with `tsc --listFiles`: **`shared.d.ts` was absent
 * from the program**, so `JsonResponse` and `ISFunction` did not resolve in a
 * `.vue` file. `global.d.ts` and `types.d.ts` survived only because something
 * else imports them transitively — which is luck, not design, and is why the
 * loss went unnoticed.
 */
describe('generated projects keep the base config files', () => {
  test('a project declaring files merges rather than replaces', async () => {
    __setTestConfig({
      plugins: [
        {
          name: 'sfc',
          tsconfig: {
            project: {
              name: 'sfc',
              // A relative path, not the `@bakery-framework/core/...` specifier
              // a real plugin writes: the workspace links core into the *apps*,
              // not into `packages/core` itself, so the specifier does not
              // resolve from the repo root. Same file either way.
              extends: './packages/core/tsconfig.vue.json',
              include: ['src/**/*.sfc'],
              // A relative path, which `resolveFilesEntry` takes as-is. A
              // package specifier would exercise `Bun.resolveSync` instead, and
              // this test is about the *merge*, not about resolution.
              files: ['./plugin-owned.d.ts'],
            },
          },
        },
      ] as any,
    })

    try {
      const names = await writeProjects({})
      const file = fs.resolve(process.cwd(), '.cache/tsconfig', 'sfc.json')
      const config = JSON.parse(await Bun.file(file).text())

      expect(names).toContain('sfc')
      // The base's three, plus the plugin's own — not the plugin's alone.
      expect(config.files.length).toBeGreaterThan(1)
      expect(config.files.some((f: string) => f.includes('shared.d.ts'))).toBe(
        true,
      )
    } finally {
      __resetTestConfig()
    }
  })

  test('a project declaring none still inherits, and stays untouched', async () => {
    // `files: []` would be worse than absent — it would tell TypeScript the
    // project contains nothing, rather than letting the base's list stand.
    const names = await writeProjects({})
    const file = fs.resolve(process.cwd(), '.cache/tsconfig', 'server.json')
    const config = JSON.parse(await Bun.file(file).text())
    expect(names).toContain('server')
    expect(config.files).toBeUndefined()
  })
})
