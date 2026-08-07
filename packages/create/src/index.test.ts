import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isScaffoldable, parseArgs, writeTemplate } from './index'
import { dependencyRange, isValidAppName, templateFiles } from './template'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'create-bakery-'))
  dirs.push(dir)
  return dir
}

describe('parseArgs', () => {
  test('a directory is the app name', () => {
    const parsed = parseArgs(['my-app'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.options.name).toBe('my-app')
    expect(parsed.options.dir).toBe(resolve('my-app'))
    expect(parsed.options.install).toBe(true)
  })

  test('--name overrides the directory', () => {
    const parsed = parseArgs(['some/nested/dir', '--name', 'chosen'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.options.name).toBe('chosen')
    expect(parsed.options.dir).toBe(resolve('some/nested/dir'))
  })

  test('--name=value is the same as --name value', () => {
    const a = parseArgs(['d', '--name=x'])
    const b = parseArgs(['d', '--name', 'x'])
    expect(a).toEqual(b)
  })

  test('"." scaffolds in place and takes the folder name', () => {
    const parsed = parseArgs(['.'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.options.dir).toBe(resolve('.'))
    // Not the literal ".", which is what basename() would give without the
    // resolve() first — and which is not a legal package name.
    expect(parsed.options.name).not.toBe('.')
    expect(isValidAppName(parsed.options.name)).toBe(true)
  })

  test('--no-install is respected', () => {
    const parsed = parseArgs(['d', '--no-install'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.options.install).toBe(false)
  })

  test('no arguments prints help rather than scaffolding somewhere', () => {
    const parsed = parseArgs([])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain('bun create bakery')
  })

  test('an unknown flag is refused, not ignored', () => {
    const parsed = parseArgs(['d', '--minify'])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain('--minify')
  })

  test('a second positional argument is refused', () => {
    // Catches `bun create bakery my app` — a space where a dash was meant,
    // which would otherwise silently scaffold into `my`.
    const parsed = parseArgs(['my', 'app'])
    expect(parsed.ok).toBe(false)
  })

  test('a name npm would reject fails here, not inside bun install', () => {
    // Not `-x`: a leading dash is an unknown *flag*, refused a line earlier
    // with a message about flags, which is the right message for it.
    for (const bad of ['My-App', '.hidden', 'has space', '_private']) {
      const parsed = parseArgs([bad])
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.message).toContain('not a usable package name')
    }
  })

  test('a scoped name is reachable through --name', () => {
    const parsed = parseArgs(['app', '--name', '@company/app'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.options.name).toBe('@company/app')
  })

  test('a scope-shaped directory is a path, not a scoped name', () => {
    // `@co/app` as the positional argument means a nested directory, because
    // that is what a path argument means. Its basename is the default name;
    // inferring a scoped package name from it instead would be a guess. This
    // pins the decision — the two readings were silently disagreeing before.
    const parsed = parseArgs(['@co/app'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.options.name).toBe('app')
    expect(parsed.options.dir).toBe(resolve('@co/app'))
  })
})

describe('isScaffoldable', () => {
  test('a directory that does not exist is fine', async () => {
    expect(await isScaffoldable(join(await tmp(), 'nope'))).toBe(true)
  })

  test('an empty directory is fine', async () => {
    expect(await isScaffoldable(await tmp())).toBe(true)
  })

  test('a directory holding anything is refused', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'notes.txt'), 'mine')
    expect(await isScaffoldable(dir)).toBe(false)
  })

  test('git init first still works', async () => {
    // `git init && bun create bakery .` is a normal thing to do, and refusing
    // it because `.git` exists would be a refusal for no reason.
    const dir = await tmp()
    await mkdir(join(dir, '.git'))
    expect(await isScaffoldable(dir)).toBe(true)
  })
})

describe('the generated app', () => {
  async function scaffold(name = 'my-app'): Promise<string> {
    const dir = await tmp()
    await writeTemplate(dir, templateFiles(name, dependencyRange('3.0.0')))
    return dir
  }

  test('writes every file, nested directories included', async () => {
    const dir = await scaffold()
    const top = (await readdir(dir)).sort()

    expect(top).toEqual([
      '.gitignore',
      'README.md',
      'orm',
      'package.json',
      'scripts',
      'server.config.ts',
      'src',
      'tsconfig.json',
    ])
    expect((await readdir(join(dir, 'src'))).sort()).toEqual([
      'api',
      'index.tsx',
      'script.ts',
    ])
    expect(await readdir(join(dir, 'src/api'))).toEqual(['notes.ts'])
  })

  test('package.json is valid JSON carrying the name and real ranges', async () => {
    const dir = await scaffold('notes-app')
    const pkg = await Bun.file(join(dir, 'package.json')).json()

    expect(pkg.name).toBe('notes-app')
    expect(pkg.private).toBe(true)
    // The point of the whole exercise: a scaffolded app depends on *published*
    // packages. `workspace:*` here would only ever work inside this repo.
    expect(pkg.dependencies).toEqual({
      '@bakery/cli': '^3.0.0',
      '@bakery/core': '^3.0.0',
      '@bakery/orm': '^3.0.0',
    })
    for (const range of Object.values(pkg.dependencies)) {
      expect(range).not.toContain('workspace:')
      expect(range).not.toContain('file:')
    }
  })

  test('the dependency range follows this package, so the two cannot drift', () => {
    expect(dependencyRange('3.1.4')).toBe('^3.1.4')

    // The published version is the one that ships, so assert against it rather
    // than a literal: bumping create-bakery must move the range it generates.
    const declared = templateFiles('x', dependencyRange('9.9.9'))
    const pkg = JSON.parse(
      declared.find(f => f.path === 'package.json')!.contents,
    )
    expect(pkg.dependencies['@bakery/core']).toBe('^9.9.9')
  })

  test('the name reaches the page and the readme, and nothing else', async () => {
    const dir = await scaffold('notes-app')
    const page = await Bun.file(join(dir, 'src/index.tsx')).text()
    const readme = await Bun.file(join(dir, 'README.md')).text()

    expect(page).toContain('<title>notes-app</title>')
    expect(readme).toContain('# notes-app')

    // No placeholder survives anywhere. A missed one is invisible until a user
    // reads the file, which is exactly the sort of thing a scaffolder ships.
    for (const file of templateFiles('notes-app', '^3.0.0')) {
      expect(file.contents).not.toContain('{{')
    }
  })

  test('db:sync does not boot a server', async () => {
    // `bakery --sync` syncs *and then serves*, so it is the wrong thing for a
    // deploy step. The generated script must drive SyncService directly.
    const dir = await scaffold()
    const pkg = await Bun.file(join(dir, 'package.json')).json()
    const script = await Bun.file(join(dir, 'scripts/db-sync.ts')).text()

    expect(pkg.scripts['db:sync']).not.toContain('--sync')
    expect(pkg.scripts['db:sync']).toBe('bun run scripts/db-sync.ts')
    expect(script).toContain("from '@bakery/orm/sync'")
    expect(script).toContain('SyncService.run()')
  })

  test('the runtime directories are ignored and the schema is not', async () => {
    const dir = await scaffold()
    const ignore = await Bun.file(join(dir, '.gitignore')).text()

    expect(ignore).toContain('node_modules')
    expect(ignore).toContain('.cache')
    expect(ignore).toContain('bakery/')
    // This repo gitignores `schema.ts` because the framework's own apps
    // generate it. A scaffolded app owns its schema and must track it.
    expect(ignore).not.toContain('schema')
  })

  test('the schema is registered, which is what makes the ORM typed', async () => {
    const dir = await scaffold()
    const index = await Bun.file(join(dir, 'orm/index.ts')).text()

    // Without this block everything runs and typechecks with permissive `any`
    // columns — a quiet enough failure to be worth generating rather than
    // documenting.
    expect(index).toContain("declare module '@bakery/orm/schema-registry'")
    expect(index).toContain('InferSchema<typeof model>')
  })
})

describe('the template only imports enumerated exports', () => {
  /**
   * The invariant worth having a test for.
   *
   * `@bakery/core` and `@bakery/orm` both still publish a `"./*"` wildcard, so
   * *every* internal file resolves today — which means a template importing the
   * wrong subpath is indistinguishable from one importing the right one, right
   * up until the wildcard is removed. MONOREPO.md gives it one release.
   *
   * Reading the real export maps rather than a hardcoded list: a subpath that
   * gets curated away should fail here, on the commit that removes it.
   */
  async function exportsOf(pkg: string): Promise<Set<string>> {
    const path = resolve(import.meta.dir, `../../${pkg}/package.json`)
    const json = await Bun.file(path).json()
    return new Set(Object.keys(json.exports ?? {}))
  }

  test('every @bakery specifier resolves without the wildcard', async () => {
    const maps = new Map([
      ['@bakery/core', await exportsOf('core')],
      ['@bakery/orm', await exportsOf('orm')],
      ['@bakery/cli', await exportsOf('cli')],
    ])

    const specifiers = new Set<string>()
    for (const file of templateFiles('x', '^3.0.0')) {
      if (!file.path.endsWith('.ts') && !file.path.endsWith('.tsx')) continue
      for (const [, spec] of file.contents.matchAll(
        /from '(@bakery\/[^']+)'/g,
      )) {
        specifiers.add(spec)
      }
      for (const [, spec] of file.contents.matchAll(
        /declare module '(@bakery\/[^']+)'/g,
      )) {
        specifiers.add(spec)
      }
    }

    // A guard on the guard: if the extraction silently matched nothing, every
    // assertion below would vacuously pass.
    expect(specifiers.size).toBeGreaterThan(2)

    for (const spec of specifiers) {
      const pkg = spec.split('/').slice(0, 2).join('/')
      const subpath = spec.slice(pkg.length)
      const entry = subpath === '' ? '.' : `.${subpath}`
      const map = maps.get(pkg)

      expect(map, `${spec} names a package that is not a dependency`).toBeDefined()
      expect(
        map!.has(entry),
        `${spec} resolves only through the "./*" wildcard, which is being removed`,
      ).toBe(true)
    }
  })

  test('the JSX options are inline, not only inherited', () => {
    // Bun's runtime does not follow tsconfig `extends` into a package
    // specifier, so inheriting these from @bakery/core/tsconfig.app.json is not
    // enough: the app transpiles with Bun's default automatic JSX runtime and
    // every .tsx route 500s with `Cannot find module 'react/jsx-dev-runtime'`.
    //
    // Typecheck cannot see this — `tsc` *does* follow the extends — so a test
    // is the only thing standing between a "dedupe these away" edit and a
    // scaffolder that emits apps whose every page is broken. apps/starter
    // shipped with exactly that bug.
    const tsconfig = JSON.parse(
      templateFiles('x', '^3.0.0').find(f => f.path === 'tsconfig.json')!
        .contents,
    )

    expect(tsconfig.compilerOptions.jsx).toBe('react')
    expect(tsconfig.compilerOptions.jsxFactory).toBe('createElement')
    expect(tsconfig.compilerOptions.jsxFragmentFactory).toBe('Fragment')
  })

  test('tsconfig extends a subpath the core package actually exports', async () => {
    const core = await exportsOf('core')
    const tsconfig = JSON.parse(
      templateFiles('x', '^3.0.0').find(f => f.path === 'tsconfig.json')!
        .contents,
    )

    // `extends` resolves through the export map exactly like an import does,
    // and this one is easy to get wrong because it carries a file extension.
    const entry = `.${tsconfig.extends.slice('@bakery/core'.length)}`
    expect(core.has(entry)).toBe(true)
  })
})
