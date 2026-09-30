import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  clearHostConfigCache,
  initConfig,
} from '../core/config'
import { fs } from '../utils/fs'
import {
  chainConfig,
  claimsAppFiles,
  coreProjects,
  defaultRootConfig,
  fromProjectDir,
  insertChainReference,
  referencesChain,
  stripGeneratedReferences,
  syncTSConfigPaths,
  wireRoot,
  writeProjects,
} from './tsconfig-sync'
import { parseJSONC } from '../utils/jsonc'

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
 * emitted `../../C:/WebDAV/.../src/**`: a glob matching nothing. A project
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
   * exactly the `../../C:/…` shape this test forbids, which is correct
   * behavior for a nonsense input and a red CI job. These globs come from
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
      // correctly yields `../../../../../home/user/x`, which contains it. That
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
 * reasoning that an alias is app-wide, so a server file could import an alias
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
    expect(byName.get('api')?.importMapPaths).toBeFalsy()
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
 * The root tsconfig gains no direct reference into `.cache/tsconfig/`, and
 * loses the ones a previous release wrote. (It gains exactly one reference,
 * to `tsconfig.bakery.json`, and only when it claims no files: see
 * `wireRoot` below.)
 *
 * The generator used to add `references` pointing at the generated projects,
 * and that broke `tsc -p <app>` for every consumer who had booted once.
 * Measured on TypeScript 6.0.3, and none of it depends on include overlap:
 *
 * - TS6306 ("must have setting composite") and TS6310 ("may not disable
 *   emit") fire for every referenced unbuilt `noEmit` project whenever the
 *   referencing program has input files: a referenced project with a
 *   disjoint include fails identically, and so does one matching zero files.
 * - TS6305 ("output file has not been built from source file") fires once per
 *   root file the referenced project also claims: `src/**`,
 *   `server.config.ts`, every `.tsx` page.
 *
 * So no include shape fixes a direct reference. The generator strips the ones
 * earlier releases left in tracked tsconfigs, and reaches the projects
 * through a composite middle file instead, from a root that claims nothing.
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

  test('every spelling of the generated path is recognized', () => {
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
    // And no files: []. That would turn the root into a solution config.
    expect(repaired?.files).toBeUndefined()
  })
})

/** What core's `tsconfig.server.json` gives a root that extends it. */
const CORE_SERVER_BASE = {
  files: ['./src/global.d.ts', './src/shared.d.ts', './src/types.d.ts'],
}

/**
 * An app with no root config still gets one that works at runtime: Bun reads
 * `compilerOptions.jsx*` from the root `tsconfig.json` and does not follow
 * `extends` into a package specifier, so the file must carry the options
 * inline. It reaches the app through the chain, and claims no files itself.
 */
describe('defaultRootConfig', () => {
  test('carries the runtime JSX options, references the chain, claims nothing', () => {
    const config = defaultRootConfig() as any
    expect(config.compilerOptions.jsx).toBe('react')
    expect(config.compilerOptions.jsxFactory).toBe('createElement')
    expect(config.compilerOptions.jsxFragmentFactory).toBe('Fragment')
    expect(config.references).toEqual([{ path: './tsconfig.bakery.json' }])
    expect(claimsAppFiles(config, CORE_SERVER_BASE)).toBe(false)
  })
})

/**
 * `tsconfig.bakery.json`: the middle layer. `composite` with `files: []` is
 * what makes it a legal reference target for a root, where the `noEmit`
 * projects it lists are not (TS6306, TS6310).
 */
describe('chainConfig', () => {
  test('lists every project it is given, and nothing of its own', () => {
    const chain = chainConfig(['server', 'api', 'client', 'vue']) as any
    expect(chain.compilerOptions).toEqual({ composite: true })
    expect(chain.files).toEqual([])
    expect(chain.references).toEqual([
      { path: './.cache/tsconfig/server.json' },
      { path: './.cache/tsconfig/api.json' },
      { path: './.cache/tsconfig/client.json' },
      { path: './.cache/tsconfig/vue.json' },
    ])
  })
})

/**
 * The rule that decides whether a root can be chained, measured on a real
 * app: a root claiming `src/**` failed `tsc -p` with 57 TS6305s once chained,
 * and one inheriting only the ambient `.d.ts` files passed.
 */
describe('claimsAppFiles', () => {
  test('an own include claims, an empty one does not', () => {
    expect(claimsAppFiles({ include: ['src/**/*.ts'] }, CORE_SERVER_BASE)).toBe(true)
    expect(claimsAppFiles({ include: [] }, CORE_SERVER_BASE)).toBe(false)
  })

  test('files claim only when they are more than declarations', () => {
    expect(claimsAppFiles({ files: ['./env.d.ts'] }, null)).toBe(false)
    expect(claimsAppFiles({ files: ['./src/index.ts'] }, null)).toBe(true)
    expect(claimsAppFiles({ files: [] }, null)).toBe(false)
  })

  test("inheriting core's ambients claims nothing, which is ecr's root", () => {
    expect(claimsAppFiles({ extends: 'x', compilerOptions: {} }, CORE_SERVER_BASE)).toBe(false)
  })

  test("neither set anywhere is TypeScript's default: every file", () => {
    expect(claimsAppFiles({ compilerOptions: {} }, null)).toBe(true)
    expect(claimsAppFiles({ compilerOptions: {} }, {})).toBe(true)
  })

  test("each key inherits on its own, and the root's own key wins over the base's", () => {
    // The root's `include` replaces the base's, even when empty.
    expect(claimsAppFiles({ include: [] }, { include: ['src/**'] })).toBe(false)
    // The root's `files` replaces the base's.
    expect(claimsAppFiles({ files: ['./a.d.ts'] }, { files: ['./src/x.ts'] })).toBe(false)
    // A key the root does not set comes from the base.
    expect(claimsAppFiles({}, { include: ['src/**'] })).toBe(true)
    // Which means setting `files` does not stop the base's `include` applying.
    expect(claimsAppFiles({ files: ['./a.d.ts'] }, { include: ['src/**'] })).toBe(true)
  })
})

/**
 * The one edit made to a developer's `tsconfig.json`, done as text so that a
 * JSONC file keeps its comments. Each case parses afterwards, with the chain
 * reference present and every original member intact.
 */
describe('insertChainReference', () => {
  const cases: Record<string, string> = {
    'a plain object': '{\n  "extends": "x",\n  "compilerOptions": { "jsx": "react" }\n}\n',
    'a trailing comma': '{\n  "extends": "x",\n  "compilerOptions": { "jsx": "react" },\n}\n',
    'a comment after the last member': '{\n  "extends": "x" // mine\n}\n',
    'a comment holding a brace': '{\n  // a } in a comment\n  "extends": "x"\n}\n',
    'a string holding a brace': '{\n  "$comment": "a } in a string",\n  "extends": "x"\n}\n',
    'an empty object': '{}\n',
    'CRLF line endings': '{\r\n  "extends": "x"\r\n}\r\n',
  }

  for (const [label, text] of Object.entries(cases)) {
    test(label, () => {
      const out = insertChainReference(text)
      expect(out).not.toBeNull()
      const parsed = parseJSONC(out as string)
      const before = parseJSONC(text)
      expect(parsed.references).toEqual([{ path: './tsconfig.bakery.json' }])
      for (const [key, value] of Object.entries(before)) {
        expect(parsed[key]).toEqual(value)
      }
    })
  }

  test('comments survive, which a parse-and-stringify rewrite would drop', () => {
    const out = insertChainReference('{\n  // keep me\n  "extends": "x"\n}\n')
    expect(out).toContain('// keep me')
  })

  test('CRLF stays CRLF', () => {
    const out = insertChainReference('{\r\n  "extends": "x"\r\n}\r\n') as string
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })

  test('no top-level object, no insertion', () => {
    expect(insertChainReference('[]')).toBeNull()
    expect(insertChainReference('')).toBeNull()
  })
})

/**
 * What a boot does to the developer's root, end to end but without the disk.
 * The property that matters is negative: nothing into `.cache/tsconfig/` is
 * ever added, and a root that claims files is left alone.
 */
describe('wireRoot', () => {
  const RUNTIME = '"compilerOptions": { "jsx": "react", "jsxFactory": "createElement" }'

  test('a root claiming nothing gets the chain reference, and nothing else', () => {
    const plan = wireRoot(`{\n  "extends": "x",\n  ${RUNTIME}\n}\n`, CORE_SERVER_BASE)
    expect(plan.wired).toBe(true)
    const root = parseJSONC(plan.text as string)
    expect(root.references).toEqual([{ path: './tsconfig.bakery.json' }])
    expect(root.compilerOptions.jsxFactory).toBe('createElement')
    expect(plan.text).not.toContain('.cache/tsconfig')
  })

  test('a root that already has it is not rewritten', () => {
    const text = `{\n  "extends": "x",\n  "references": [{ "path": "./tsconfig.bakery.json" }]\n}\n`
    const plan = wireRoot(text, CORE_SERVER_BASE)
    expect(plan).toEqual({ text: null, stripped: false, wired: false, claims: false })
    expect(referencesChain(parseJSONC(text))).toBe(true)
  })

  test('a root claiming files is left unwired, and says so', () => {
    const text = `{\n  "extends": "x",\n  "include": ["src/**/*.ts"]\n}\n`
    expect(wireRoot(text, CORE_SERVER_BASE)).toEqual({
      text: null,
      stripped: false,
      wired: false,
      claims: true,
    })
  })

  test('old direct references are stripped, then the chain is added', () => {
    const text = `{\n  "extends": "x",\n  "references": [{ "path": "./.cache/tsconfig/server.json" }, { "path": "../shared" }]\n}\n`
    const plan = wireRoot(text, CORE_SERVER_BASE)
    expect(plan.stripped).toBe(true)
    expect(plan.wired).toBe(true)
    const root = parseJSONC(plan.text as string)
    // The developer's own reference survives; ours is replaced by the chain.
    expect(root.references).toEqual([
      { path: '../shared' },
      { path: './tsconfig.bakery.json' },
    ])
  })

  test('a claiming root still loses the old direct references', () => {
    const text = `{\n  "include": ["src/**/*.ts"],\n  "references": [{ "path": ".cache/tsconfig/client.json" }]\n}\n`
    const plan = wireRoot(text, CORE_SERVER_BASE)
    expect(plan).toMatchObject({ stripped: true, wired: false, claims: true })
    expect(parseJSONC(plan.text as string).references).toBeUndefined()
  })
})

/**
 * Between them, core's projects claim each app file exactly once. A file
 * nobody claims falls into an inferred project with no `bun-types`, which is
 * the bug this layout exists to end, and a file claimed twice goes to
 * whichever project an editor happens to load first.
 *
 * Matched with TypeScript's semantics for the two things `Bun.Glob` does not
 * share: a pattern with no wildcard names a directory and everything under
 * it, and `**` also matches no directory at all.
 */
describe('the core projects claim every app file once', () => {
  function claims(pattern: string, path: string): boolean {
    if (!/[*?]/.test(pattern)) {
      return path === pattern || path.startsWith(`${pattern}/`)
    }
    return (
      new Bun.Glob(pattern).match(path) ||
      new Bun.Glob(pattern.replace(/\*\*\//g, '')).match(path)
    )
  }

  function owners(path: string): string[] {
    __setTestConfig({ root: 'src' } as any)
    try {
      return coreProjects()
        .filter(
          p =>
            (p.include ?? []).some(g => claims(g, path)) &&
            !(p.exclude ?? []).some(g => claims(g, path)),
        )
        .map(p => p.name)
    } finally {
      __resetTestConfig()
    }
  }

  const expected: Record<string, string[]> = {
    'src/api/auth/login.ts': ['api'],
    'src/admin/api/students.ts': ['api'],
    'src/composables/useData.ts': ['client'],
    'src/index.tsx': ['server'],
    'src/api/page.tsx': ['server'],
    'server.config.ts': ['server'],
    'schema.ts': ['server'],
    'orm/tables.ts': ['server'],
    'scripts/db-sync.ts': ['server'],
    'tests/auth.test.ts': ['server'],
    'migrations/001-accounts.ts': ['server'],
    'node_modules/pkg/index.ts': [],
    '.cache/vue/server/page.ts': [],
  }

  for (const [path, want] of Object.entries(expected)) {
    test(path, () => {
      expect(owners(path)).toEqual(want)
    })
  }
})

/**
 * The shipped apps carry the shape the generator maintains: no direct
 * reference into `.cache/tsconfig/`, the chain reference, and no app files of
 * their own. The first half is the assertion that bit at the artifact level:
 * `bunx tsc -p apps/example` once failed with ten TS6305s plus a TS6306/TS6310
 * pair per referenced project.
 */
describe('shipped app tsconfigs are wired to the chain', () => {
  for (const rel of [
    'apps/example/tsconfig.json',
    'apps/starter/tsconfig.json',
  ]) {
    test(rel, async () => {
      const abs = fs.resolve(import.meta.dir, '../../../..', rel)
      const config = parseJSONC(await Bun.file(abs).text()) as Record<
        string,
        unknown
      >
      expect(stripGeneratedReferences(config)).toBeNull()
      expect(referencesChain(config)).toBe(true)
      expect(claimsAppFiles(config, CORE_SERVER_BASE)).toBe(false)
    })
  }
})

/**
 * The generator end to end: what actually lands in `.cache/tsconfig/`.
 *
 * `writeProjects` only writes that directory (it does not touch the app's root
 * config), so it is safe to call here, and it is the honest place to assert the
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
      'api',
      'client',
      'jobs',
      'server',
      'sfc',
    ])

    // The two that compile browser code.
    expect(projects.client.compilerOptions.paths).toBeDefined()
    expect(projects.sfc.compilerOptions.paths).toBeDefined()

    // The three that do not. An `importMap` alias here would typecheck an
    // import the server cannot resolve: the bug this gate closes.
    expect(projects.server.compilerOptions.paths).toBeUndefined()
    expect(projects.api.compilerOptions.paths).toBeUndefined()
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
 * else imports them transitively, which is luck, not design, and is why the
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
      // The base's three, plus the plugin's own, not the plugin's alone.
      expect(config.files.length).toBeGreaterThan(1)
      expect(config.files.some((f: string) => f.includes('shared.d.ts'))).toBe(
        true,
      )
    } finally {
      __resetTestConfig()
    }
  })

  test('a project declaring none still inherits, and stays untouched', async () => {
    // `files: []` would be worse than absent. It would tell TypeScript the
    // project contains nothing, rather than letting the base's list stand.
    const names = await writeProjects({})
    const file = fs.resolve(process.cwd(), '.cache/tsconfig', 'server.json')
    const config = JSON.parse(await Bun.file(file).text())
    expect(names).toContain('server')
    expect(config.files).toBeUndefined()
  })
})
