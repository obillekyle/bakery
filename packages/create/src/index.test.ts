import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  isScaffoldable,
  ownVersion,
  parseArgs,
  resolveChoices,
  writeTemplate,
} from './index'
import {
  applyConfirmKey,
  applyKey,
  type KeyResult,
  type MultiselectState,
  renderMultiselect,
} from './prompt'
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

  test('the emitted range tracks this package, not a literal', async () => {
    // The two halves of the no-drift claim. `dependencyRange` is pure and
    // tested above; this is the half that touches disk, and it is the half that
    // breaks silently — if the relative URL in `ownVersion` stops resolving,
    // every other test here still passes while generated apps pin the wrong
    // major.
    const declared = await Bun.file(
      resolve(import.meta.dir, '../package.json'),
    ).json()

    expect(await ownVersion()).toBe(declared.version)
    expect(dependencyRange(await ownVersion())).toBe(`^${declared.version}`)
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
    expect(index).toContain('InferSchema<Model>')
    // Tables *and* views. Inferring from tables alone leaves `InferViews`
    // empty, and a view is then writable — which is the whole thing declaring
    // one is meant to prevent.
    expect(index).toContain('type Model = typeof tables & typeof views')
    expect(index).toContain('InferViews<Model>')
  })

  test('the orm folder is one file per kind of declaration', async () => {
    const dir = await scaffold()
    for (const f of ['tables.ts', 'views.ts', 'indexes.ts', 'index.ts']) {
      expect({
        f,
        exists: await Bun.file(join(dir, 'orm', f)).exists(),
      }).toEqual({ f, exists: true })
    }
    // `schema.ts` was the old name for `tables.ts`; a scaffold should not emit
    // both, or `collectConstraints` silently keeps whichever exported last.
    expect(await Bun.file(join(dir, 'orm/schema.ts')).exists()).toBe(false)
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

      expect(
        map,
        `${spec} names a package that is not a dependency`,
      ).toBeDefined()
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

/**
 * The ORM and the plugins are choices now, and the flags are what make that
 * choice reproducible — `bun create` runs in scripts and Dockerfiles as often
 * as it runs for a person, and neither of those can answer a prompt.
 */
describe('--orm / --no-orm / --plugins', () => {
  const opts = (argv: string[]) => {
    const parsed = parseArgs(argv)
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.options
  }

  test('unspecified is null, not a default', () => {
    // The distinction is the whole design: null means "ask", and a default
    // baked in at parse time would make the prompt unreachable.
    const o = opts(['app'])
    expect({ orm: o.orm, plugins: o.plugins }).toEqual({
      orm: null,
      plugins: null,
    })
  })

  test('--orm and --no-orm both state an answer', () => {
    expect(opts(['app', '--orm']).orm).toBe(true)
    expect(opts(['app', '--no-orm']).orm).toBe(false)
  })

  test('--plugins takes a list, in either syntax', () => {
    expect(opts(['app', '--plugins', 'vue,analytics']).plugins).toEqual([
      'vue',
      'analytics',
    ])
    expect(opts(['app', '--plugins=dashboard']).plugins).toEqual(['dashboard'])
  })

  test('order and duplicates are normalised', () => {
    // So two people who typed the same set in a different order get identical
    // apps, and a diff between them is empty.
    expect(opts(['app', '--plugins', 'dashboard,vue']).plugins).toEqual([
      'vue',
      'dashboard',
    ])
    expect(opts(['app', '--plugins', 'vue,vue']).plugins).toEqual(['vue'])
  })

  test('--plugins none is an explicit empty set', () => {
    expect(opts(['app', '--plugins', 'none']).plugins).toEqual([])
  })

  test('an unknown plugin is refused by name, and lists the real ones', () => {
    const parsed = parseArgs(['app', '--plugins', 'vue,redis'])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected failure')
    expect(parsed.message).toContain('redis')
    expect(parsed.message).toContain('dashboard')
  })

  test('an empty --plugins= is a mistake, not an empty set', () => {
    expect(parseArgs(['app', '--plugins=']).ok).toBe(false)
  })

  test('--yes is carried through', () => {
    expect(opts(['app', '--yes']).yes).toBe(true)
    expect(opts(['app', '-y']).yes).toBe(true)
    expect(opts(['app']).yes).toBe(false)
  })
})

describe('resolveChoices', () => {
  const base = { dir: '/tmp/x', name: 'x', install: true, yes: false }

  test('a non-interactive run takes the defaults rather than hanging', async () => {
    // `bun test` is not a TTY, which is the same situation as CI and a pipe. A
    // scaffolder that blocks on a prompt there cannot be scripted.
    const choices = await resolveChoices({ ...base, orm: null, plugins: null })
    expect(choices).toEqual({ orm: true, plugins: [] })
  })

  test('flags win without asking', async () => {
    const choices = await resolveChoices({
      ...base,
      orm: false,
      plugins: ['vue'],
    })
    expect(choices).toEqual({ orm: false, plugins: ['vue'] })
  })
})

describe('templateFiles with choices', () => {
  const range = '^4.0.0'
  const paths = (files: { path: string }[]) => files.map(f => f.path).sort()
  const pkgOf = (files: { path: string; contents: string }[]) =>
    JSON.parse(files.find(f => f.path === 'package.json')!.contents)
  const fileOf = (files: { path: string; contents: string }[], p: string) =>
    files.find(f => f.path === p)?.contents ?? ''

  test('the default is what it has always been: ORM in, no plugins', () => {
    const files = templateFiles('app', range)
    expect(paths(files)).toContain('orm/tables.ts')
    expect(pkgOf(files).dependencies['@bakery/orm']).toBe(range)
    expect(pkgOf(files).scripts['db:sync']).toBeDefined()
    expect(fileOf(files, 'server.config.ts')).not.toContain('plugins:')
  })

  test('--no-orm drops the files, the dependency and the script', () => {
    const files = templateFiles('app', range, { orm: false, plugins: [] })
    expect(paths(files).filter(p => p.startsWith('orm/'))).toEqual([])
    expect(paths(files)).not.toContain('scripts/db-sync.ts')
    expect(pkgOf(files).dependencies['@bakery/orm']).toBeUndefined()
    expect(pkgOf(files).scripts['db:sync']).toBeUndefined()
    // …and the tsconfig stops including directories that no longer exist.
    expect(fileOf(files, 'tsconfig.json')).not.toContain('orm/**/*.ts')
  })

  test('--no-orm still ships a working API route', () => {
    // The route is the thing most likely to be left importing a package that is
    // no longer a dependency — which installs fine and fails at first request.
    const files = templateFiles('app', range, { orm: false, plugins: [] })
    const route = fileOf(files, 'src/api/notes.ts')
    // An *import* of it, not a mention: the comment in that file points at
    // `@bakery/orm` as the thing to add later, which is the whole point of
    // the comment.
    expect(route).not.toContain("from '@bakery/orm'")
    expect(route).toContain('defineRoute')
    // The client script is shared, so the shape it reads has to survive.
    expect(route).toContain('response.json.success')
  })

  test('no generated file imports a package that is not a dependency', () => {
    for (const orm of [true, false]) {
      const files = templateFiles('app', range, { orm, plugins: [] })
      const declared = Object.keys(pkgOf(files).dependencies)
      const body = files
        .filter(f => f.path !== 'package.json' && f.path !== 'README.md')
        .map(f => f.contents)
        .join('\n')
      for (const spec of body.matchAll(/from '(@bakery\/[^']+)'/g)) {
        const pkg = spec[1]!.split('/').slice(0, 2).join('/')
        expect({ orm, pkg, declared: declared.includes(pkg) }).toEqual({
          orm,
          pkg,
          declared: true,
        })
      }
    }
  })

  test('a plugin adds its package and registers it', () => {
    const files = templateFiles('app', range, {
      orm: true,
      plugins: ['analytics'],
    })
    expect(pkgOf(files).dependencies['@bakery/plugin-analytics']).toBe(range)
    const config = fileOf(files, 'server.config.ts')
    expect(config).toContain(
      "import analyticsPlugin from '@bakery/plugin-analytics'",
    )
    expect(config).toContain('analyticsPlugin(),')
  })

  test('vue brings its peers, or SFCs fail after a clean install', () => {
    const files = templateFiles('app', range, { orm: true, plugins: ['vue'] })
    const deps = pkgOf(files).dependencies
    expect(deps.vue).toBe('^3.5.0')
    expect(deps['@vue/compiler-sfc']).toBe('^3.5.0')
  })

  test('the dashboard is scaffolded without an authorize predicate', () => {
    // Omitted, it is loopback-only in dev and denied in production. A generated
    // app must not be born with an open console — apps/example passes
    // `() => true` because it is a local demo, and copying that here would ship
    // every scaffolded app with the console open to anyone.
    const files = templateFiles('app', range, {
      orm: true,
      plugins: ['dashboard'],
    })
    const config = fileOf(files, 'server.config.ts')
    expect(config).toContain('dashboardPlugin(),')
    expect(config).not.toContain('authorize: () => true')
  })

  test('dependencies are sorted, so the file does not churn', () => {
    const files = templateFiles('app', range, {
      orm: true,
      plugins: ['dashboard', 'vue'],
    })
    const keys = Object.keys(pkgOf(files).dependencies)
    expect(keys).toEqual([...keys].sort())
  })
})

/**
 * The prompt's state machine, tested without a terminal.
 *
 * This is why the key handling is a pure function: raw-mode stdin cannot be
 * driven from `bun test`, and a multiselect whose arrow keys were never
 * exercised is one that gets found broken by the first person to use it.
 */
describe('multiselect key handling', () => {
  const CHOICES = [
    { id: 'vue', label: 'vue' },
    { id: 'analytics', label: 'analytics' },
    { id: 'dashboard', label: 'dashboard' },
  ]
  const fresh = (): MultiselectState => ({
    choices: CHOICES,
    cursor: 0,
    selected: new Set<string>(),
  })
  const press = (state: MultiselectState, ...keys: string[]) => {
    let result: KeyResult = { kind: 'update', state }
    for (const key of keys) {
      if (result.kind === 'cancel') return result
      result = applyKey(result.state, key)
    }
    return result
  }
  const DOWN = '\x1b[B'
  const UP = '\x1b[A'

  test('space toggles the item under the cursor', () => {
    const r = press(fresh(), ' ')
    if (r.kind === 'cancel') throw new Error('cancelled')
    expect([...r.state.selected]).toEqual(['vue'])
  })

  test('space again deselects it', () => {
    const r = press(fresh(), ' ', ' ')
    if (r.kind === 'cancel') throw new Error('cancelled')
    expect([...r.state.selected]).toEqual([])
  })

  test('the cursor moves and wraps in both directions', () => {
    const down = press(fresh(), DOWN, DOWN, DOWN)
    if (down.kind === 'cancel') throw new Error('cancelled')
    expect(down.state.cursor).toBe(0)

    const up = press(fresh(), UP)
    if (up.kind === 'cancel') throw new Error('cancelled')
    expect(up.state.cursor).toBe(2)
  })

  test('a selects everything, and again clears it', () => {
    const all = press(fresh(), 'a')
    if (all.kind === 'cancel') throw new Error('cancelled')
    expect(all.state.selected.size).toBe(3)

    const none = press(fresh(), 'a', 'a')
    if (none.kind === 'cancel') throw new Error('cancelled')
    expect(none.state.selected.size).toBe(0)
  })

  test('enter submits what is selected', () => {
    const r = press(fresh(), ' ', DOWN, DOWN, ' ', '\r')
    if (r.kind !== 'submit') throw new Error(`expected submit, got ${r.kind}`)
    expect([...r.state.selected].sort()).toEqual(['dashboard', 'vue'])
  })

  test('ctrl-c cancels, and cancelling is not an empty selection', () => {
    // Distinct outcomes on purpose: Ctrl-C must not scaffold, and returning an
    // empty array here would have it scaffold with no plugins instead.
    expect(press(fresh(), ' ', '\x03').kind).toBe('cancel')
  })

  test('an unrecognised key changes nothing', () => {
    const r = press(fresh(), 'q')
    if (r.kind === 'cancel') throw new Error('cancelled')
    expect({ cursor: r.state.cursor, size: r.state.selected.size }).toEqual({
      cursor: 0,
      size: 0,
    })
  })

  test('the state is replaced, never mutated', () => {
    // A mutated Set makes a stale frame indistinguishable from a fresh one,
    // which is the kind of bug that only shows up as flicker.
    const before = fresh()
    const r = applyKey(before, ' ')
    if (r.kind === 'cancel') throw new Error('cancelled')
    expect(before.selected.size).toBe(0)
    expect(r.state.selected.size).toBe(1)
  })
})

describe('confirm key handling', () => {
  test('y and n answer regardless of the default', () => {
    expect(applyConfirmKey('y', false)).toEqual({ kind: 'answer', value: true })
    expect(applyConfirmKey('n', true)).toEqual({ kind: 'answer', value: false })
  })

  test('enter takes the default', () => {
    expect(applyConfirmKey('\r', true)).toEqual({ kind: 'answer', value: true })
    expect(applyConfirmKey('\r', false)).toEqual({
      kind: 'answer',
      value: false,
    })
  })

  test('ctrl-c cancels and anything else is ignored', () => {
    expect(applyConfirmKey('\x03', true).kind).toBe('cancel')
    expect(applyConfirmKey('z', true).kind).toBe('ignore')
  })
})

describe('renderMultiselect', () => {
  test('marks the selected rows and points at the cursor', () => {
    const frame = renderMultiselect('Plugins', {
      choices: [
        { id: 'vue', label: 'vue', hint: 'SFCs' },
        { id: 'analytics', label: 'analytics' },
      ],
      cursor: 1,
      selected: new Set(['vue']),
    })
    expect(frame).toContain('◉')
    expect(frame).toContain('◯')
    expect(frame).toContain('❯')
    expect(frame).toContain('SFCs')
    // One line per choice, plus the question.
    expect(frame.trimEnd().split('\n')).toHaveLength(3)
  })
})
