import { describe, expect, test } from 'bun:test'

/**
 * The conventions in CLAUDE.md, as a failing test.
 *
 * Prose conventions rot. Across six packages the only thing holding these
 * together was that someone remembered them, and the two violations this file
 * found on the day it was written had both been sitting in the tree for
 * months — one of them silently breaking four tests in an unrelated file
 * whenever Bun happened to order two files the wrong way round.
 *
 * Every check here was verified to pass when it was written, so a failure
 * means something drifted rather than that the rule is aspirational.
 *
 * These are greps, not a type system, and a check only earns its place if it
 * has a low false-positive rate. A rule that cries wolf gets commented out,
 * and a commented-out rule is worse than none: it reads as enforced.
 */

const ROOT = `${import.meta.dir}/..`

interface SourceFile {
  /** Repo-relative, forward slashes on every platform. */
  path: string
  /** Raw text, comments included. */
  text: string
  /**
   * Lines whose content is entirely a comment, blanked. Nearly every check
   * runs against this rather than the raw text: the conventions are quoted in
   * the comments of the very files they govern, so a naive grep reports the
   * documentation as the violation.
   */
  code: string[]
}

const COMMENT_ONLY = /^\s*(\/\/|\/\*|\*)/

async function loadSources(pattern: string): Promise<SourceFile[]> {
  const glob = new Bun.Glob(pattern)
  const files: SourceFile[] = []

  for await (const scanned of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    // Bun's Glob yields native separators; everything downstream assumes '/'.
    const path = scanned.replace(/\\/g, '/')
    if (path.includes('node_modules/') || path.includes('/dist/')) continue

    const text = await Bun.file(`${ROOT}/${path}`).text()
    files.push({
      path,
      text,
      code: text.split('\n').map(line => (COMMENT_ONLY.test(line) ? '' : line)),
    })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

const packageSources = await loadSources('packages/**/*.{ts,tsx}')
const appSources = await loadSources('apps/**/*.{ts,tsx}')
const allSources = [...packageSources, ...appSources]

const isTest = (f: SourceFile) => /\.test\.tsx?$/.test(f.path)
const isClient = (f: SourceFile) => f.path.includes('/client/')

/** `path:line  source` for every line of `files` matching `pattern`. */
function find(files: SourceFile[], pattern: RegExp): string[] {
  const hits: string[] = []

  for (const file of files) {
    file.code.forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${file.path}:${i + 1}  ${line.trim()}`)
    })
  }

  return hits
}

/**
 * Whether `index` falls inside a string literal on `line`.
 *
 * Needed because the Vue plugin *generates* browser code containing a bare
 * `catch {}`. That is emitted output, not this codebase's control flow, and
 * the alternative — parsing every file to tell code from string — costs far
 * more than one heuristic that only has to be right about quote nesting on a
 * single line.
 */
function insideStringLiteral(line: string, index: number): boolean {
  let backtick = false
  let single = false
  let double = false

  for (let i = 0; i < index; i++) {
    const ch = line[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`' && !single && !double) backtick = !backtick
    else if (ch === "'" && !backtick && !double) single = !single
    else if (ch === '"' && !backtick && !single) double = !double
  }

  return backtick || single || double
}

/** Names declared at the top level of a file's `declare global` block. */
function ambientDeclarations(
  file: SourceFile,
): { kind: string; name: string }[] {
  const lines = file.text.split('\n')
  const start = lines.findIndex(line => /^declare global\s*\{/.test(line))
  if (start === -1) return []

  const found: { kind: string; name: string }[] = []
  const DECLARATION =
    /^ {2}(var|const|type|interface|namespace|function)\s+([A-Za-z_$][\w$]*)/

  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) break
    const match = DECLARATION.exec(lines[i])
    if (match) found.push({ kind: match[1], name: match[2] })
  }

  return found
}

/** Top-level keys of every `Object.assign(globalThis, { … })` in a file. */
function globalThisBindings(text: string): string[] {
  const names: string[] = []
  let inBlock = false

  for (const line of text.split('\n')) {
    if (/Object\.assign\(\s*globalThis\s*,\s*\{/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    if (/^\}\)/.test(line)) {
      inBlock = false
      continue
    }
    const match = /^ {2}([A-Za-z_$][\w$]*)\s*[,:(]/.exec(line)
    if (match) names.push(match[1])
  }

  return names
}

describe('conventions (CLAUDE.md)', () => {
  test('logging is data — no console.* in server code', () => {
    // The exceptions CLAUDE.md documents. All emit program output rather than
    // log lines: CLI usage text, and the bootstrap catch that wraps the very
    // imports which load the logger.
    //
    // `create-bakery` is the third and is exempt wholesale rather than by line:
    // it is a standalone scaffolder with no dependency on the framework at all,
    // so there is no logger to route through — every byte it prints is for a
    // human watching `bun create bakery` run.
    const ALLOWED = new Set([
      'packages/cli/src/index.ts',
      'packages/orm/src/sync/index.ts',
      'packages/create/src/index.ts',
      // Same exception as sync/index.ts and for the same reason: `--help` is
      // program output. Both files use the logger for everything else they say.
      'packages/orm/src/sync/history.ts',
      'packages/orm/src/sync/rollback.ts',
    ])

    const serverCode = packageSources.filter(
      f => !isTest(f) && !isClient(f) && !ALLOWED.has(f.path),
    )

    // `console.clear()` is exempt by name, not by file: it emits no message.
    // It is terminal control, sitting beside the `tty.disableRawMode()` in the
    // dev watcher's restart path — the logging happens on the line above it.
    expect(find(serverCode, /\bconsole\.(?!clear\b)\w+\s*\(/)).toEqual([])
  })

  /**
   * The mode flags are accessors `core/init` installs on `process.env`, and Bun
   * runs every test file in one process — so a file that mishandles one changes
   * what a *different* file reads, and only under full-suite ordering. Both
   * checks below were written against a real instance of exactly that: two
   * `NMHandler` tests that passed in isolation and failed in the suite, because
   * `bundleModule` passes `PROD` to `Bun.build` as `minify` and Bun rejects a
   * non-boolean rather than coercing it.
   *
   * Three files got there by two different routes, which is why this is two
   * rules rather than one.
   */
  const MODE_FLAGS =
    'DEV|PROD|TEST|WORKER|DEV_WORKER|THREAD_WORKER|THREAD_ID|MODE'

  test('no source deletes a mode flag it does not own', () => {
    // Capturing a flag's descriptor before `core/init` has loaded captures
    // nothing, and the restore then deletes the accessor init installed in the
    // meantime — leaving the flag `undefined` for every file that runs after.
    //
    // Import `core/init` before capturing so the capture is real, or swap the
    // flag with `withEnvFlag` (`packages/core/src/tests/fixtures.ts`).
    //
    // `engine.test.ts` legitimately deletes `PROD`: it asserts what
    // `isProductionSync()` does in a process that never loaded init, which
    // cannot be said without removing the flag. It is safe there because it
    // imports init before capturing, so its `afterEach` puts a real accessor
    // back rather than nothing.
    const ALLOWED = new Set(['packages/orm/src/sync/engine.test.ts'])
    const pattern = new RegExp(
      `delete\\s*\\(?\\s*\\(?process\\.env[^\\n]{0,40}?(?:\\.|\\[['"\`])(?:${MODE_FLAGS})\\b`,
    )
    const offenders = find(allSources, pattern).filter(
      hit => !ALLOWED.has(hit.split(':')[0]),
    )
    expect(offenders).toEqual([])
  })

  test('no source assigns a mode flag through process.env', () => {
    // The subtler of the two, and the one that survived the first fix.
    //
    // Bun's `process.env` is a proxy that **stringifies on write but not on
    // read**, so the round trip that looks obviously correct is not:
    //
    //   const saved = process.env.PROD   // boolean true
    //   process.env.PROD = saved         // string "true"
    //
    // A file restoring `PROD` this way put back a value of the wrong type, and
    // the failure surfaced in an unrelated package. Assigning a literal has the
    // same effect: `process.env.PROD = '1'` is truthy and passes every test
    // that reads it as a condition, right up until something reads it as a
    // boolean.
    //
    // `setModeFlag` (`packages/core/src/tests/fixtures.ts`) calls the
    // descriptor's own setter, which reaches init's closure without passing
    // through the proxy.
    //
    // `init.ts` itself is exempt: `Object.defineProperties` is how the
    // accessors get installed, and it is not an assignment. `threads.ts` is
    // exempt for `THREAD_ID`, which is genuinely a string.
    const ALLOWED = new Set([
      'packages/core/src/core/init.ts',
      'packages/cli/src/threads.ts',
    ])
    const pattern = new RegExp(
      `process\\.env(?:\\.|\\[['"\`])(?:${MODE_FLAGS})(?:['"\`]\\])?\\s*=[^=]`,
    )
    const offenders = find(allSources, pattern).filter(
      hit => !ALLOWED.has(hit.split(':')[0]),
    )
    expect(offenders).toEqual([])
  })

  test('test seams, not module mocks — no mock.module anywhere', () => {
    // Bun's module mocks are process-global and never restored, so they leak
    // into every file loaded afterwards. This is not style: ip.test.ts mocked
    // core/bakery and left `Bakery.config` undefined for the rest of the run,
    // which broke four tests in tests/multi-host.test.ts by file order alone.
    expect(find(allSources, /\bmock\.module\s*\(/)).toEqual([])
  })

  test('utils/isomorphic stays pure', () => {
    // Compiled into the browser bundle as-is: no Bun, no node builtins, no
    // DOM, no process.
    const isomorphic = packageSources.filter(f =>
      f.path.includes('/utils/isomorphic/'),
    )

    expect(isomorphic.length).toBeGreaterThan(0)
    expect(
      find(
        isomorphic,
        /\bBun\.|from\s+['"]node:|\bdocument\.|\bwindow\.|\blocalStorage\b|\bprocess\./,
      ),
    ).toEqual([])
  })

  test('the package graph stays acyclic', () => {
    // core ← orm ← plugins, with cli the only package depending on both.
    // MONOREPO.md verified this once by grep; this keeps it verified.
    const RULES = [
      { dir: 'packages/core/', banned: /@bakery\/(orm|cli|plugin-)/ },
      { dir: 'packages/orm/', banned: /@bakery\/(cli|plugin-)/ },
      { dir: 'packages/plugins/', banned: /@bakery\/(cli|plugin-)/ },
    ]

    const offenders: string[] = []
    for (const rule of RULES) {
      const files = packageSources.filter(f => f.path.startsWith(rule.dir))
      const specifier = new RegExp(
        `(?:from|import)\\s*\\(?\\s*['"][^'"]*${rule.banned.source}`,
      )
      offenders.push(...find(files, specifier))
    }

    expect(offenders).toEqual([])
  })

  test('one Bun.serve, and it lives in the CLI worker', () => {
    const owners = find(
      packageSources.filter(f => !isTest(f)),
      /\bBun\.serve\s*\(/,
    )

    expect(owners.map(hit => hit.split(':')[0])).toEqual([
      'packages/cli/src/worker.ts',
    ])
  })

  test('SQL identifiers have exactly one writer', () => {
    // Everything that interpolates a table/column name goes through qId/qRef/
    // qRaw, so the quote-stripping inside quoteIdentifier can never be skipped.
    const ALLOWED = new Set([
      'packages/orm/src/adapters/base.ts', // defines it
      'packages/orm/src/schema-util.ts', // qRaw, the single caller
    ])

    const callers = find(
      packageSources.filter(f => !isTest(f) && !ALLOWED.has(f.path)),
      /\bquoteIdentifier\s*\(/,
    )

    expect(callers).toEqual([])
  })

  test('one JSON envelope — nothing hand-rolls a JSON response', () => {
    // {time, status, message, data} via response.json.*, for every JSON body
    // the server emits.
    const ALLOWED = new Set(['packages/core/src/utils/http/response.ts'])

    const handRolled = find(
      packageSources.filter(f => !isTest(f) && !isClient(f) && !ALLOWED.has(f.path)),
      /new Response\s*\(\s*JSON\.stringify|Response\.json\s*\(/,
    )

    expect(handRolled).toEqual([])
  })

  test('no silently swallowed errors', () => {
    // Try/Try.catch is the idiom. A bare `catch {}` may stay only with a
    // comment saying why silence is correct — which is the whole point, since
    // every one of these is a place a real failure can go unreported.
    const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*\}/g
    const offenders: string[] = []

    for (const file of allSources) {
      file.text.split('\n').forEach((line, i) => {
        EMPTY_CATCH.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = EMPTY_CATCH.exec(line))) {
          if (insideStringLiteral(line, match.index)) continue
          offenders.push(`${file.path}:${i + 1}  ${line.trim()}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })

  test('no global type or var is declared twice', () => {
    // `interface` and `namespace` declarations merge — that is how an app
    // augments SessionData, and it is legal. `type` and `var` cannot merge:
    // a second declaration is TS2300, which nobody ever saw because
    // skipLibCheck suppresses errors inside .d.ts files. MapOf, Wrapped,
    // JsonResponse and ISFunction sat duplicated between global.d.ts and
    // client/globals.d.ts for exactly that reason.
    const seen = new Map<string, string[]>()

    for (const file of allSources.filter(f => f.path.endsWith('.d.ts'))) {
      for (const { kind, name } of ambientDeclarations(file)) {
        if (kind === 'interface' || kind === 'namespace') continue
        seen.set(name, [...(seen.get(name) ?? []), file.path])
      }
    }

    const duplicated = [...seen]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name} declared in ${files.join(' and ')}`)

    expect(duplicated).toEqual([])
  })

  test('every ambient global var is bound at runtime', () => {
    // A `var` in `declare global` that nothing assigns onto globalThis is a
    // trap, not a convenience: it typechecks in every file in the repo and
    // throws ReferenceError the moment it runs. `var req: Request` and
    // `var body: any` were precisely that, for as long as they existed.
    // Allow-listed per *file*, not per name: `req` in the Vue plugin's
    // vue.d.ts is a real compiler-injected binding, while the identical
    // declaration in core's global.d.ts was a trap. Scoping by file is what
    // keeps the first from re-legitimising the second.
    const ALLOWED = new Set([
      // The compiler emits `export default async function (req, body, …)`
      // around a <script server> block, so both are genuine parameters there.
      // They are bound only inside a .vue server block — which is why this
      // file must not be pulled into a program of .ts/.tsx sources.
      'req@packages/plugins/vue/src/vue.d.ts',
      'body@packages/plugins/vue/src/vue.d.ts',
      // Injected into each Vue SFC's module scope by the same path: the
      // __BAKERY_VUE_SERVER_DATA__ token becomes `(globalThis.__vue_server || {})`.
      'server@packages/core/src/client/globals.d.ts',
    ])

    const bound = new Set<string>()
    for (const file of allSources) {
      for (const name of globalThisBindings(file.text)) bound.add(name)
    }

    const unbound: string[] = []
    for (const file of allSources.filter(f => f.path.endsWith('.d.ts'))) {
      for (const { kind, name } of ambientDeclarations(file)) {
        if (kind !== 'var' && kind !== 'const') continue
        if (bound.has(name) || ALLOWED.has(`${name}@${file.path}`)) continue
        unbound.push(`${name} (${file.path})`)
      }
    }

    expect(unbound).toEqual([])
  })

  test('no focused tests committed', () => {
    // One stray .only turns a green suite into a single passing test.
    const focused = find(
      allSources.filter(isTest),
      /\b(test|describe|it)\.only\s*\(/,
    )

    expect(focused).toEqual([])
  })

  test('every @bakery import names an enumerated export', async () => {
    // The export maps no longer carry a `"./*"` wildcard, so a subpath that is
    // not listed does not exist for anyone who installs the package. In-repo it
    // still resolves — Bun reaches workspace packages through a symlink and
    // does not apply their export map — so nothing fails here until a consumer
    // installs a tarball, which is the worst place to find out.
    //
    // Verified against a real extracted tarball when the wildcard was removed:
    // `@bakery/core/cache/tiered` and its neighbours are blocked while every
    // enumerated path resolves. This keeps it that way.
    //
    // The fix for a failure is to add the subpath to that package's `exports`,
    // and it is meant to be a deliberate edit: it is public API from then on.
    const maps: Record<string, Set<string>> = {}
    for (const dir of [
      'packages/core',
      'packages/orm',
      'packages/cli',
      'packages/plugins/vue',
      'packages/plugins/analytics',
      'packages/plugins/dashboard',
    ]) {
      const json = await Bun.file(`${ROOT}/${dir}/package.json`).json()
      const entries = Object.keys(json.exports ?? {})
      // A package that still has a wildcard cannot be checked by this rule, and
      // must not pass silently as though it had been curated. `./templates/*`
      // is data files, not modules.
      expect(
        entries.filter(e => e.includes('*') && e !== './templates/*'),
      ).toEqual([])
      maps[json.name] = new Set(entries)
    }

    // Built with `new RegExp` rather than a literal: an escaped slash in a
    // regex literal is exactly the character that has been silently eaten
    // rewriting this tree before.
    //
    // **Both spellings.** This matched only `from '…'` until it was found to be
    // missing four live offenders, all of them `await import('…')` — the form
    // the CLI uses for nearly everything it pulls out of core, because it is
    // lazy-loading on purpose. `@bakery/core/cache/tiered`,
    // `core/compiler/tsconfig-sync`, `core/core/plugins` and `orm/sync/load`
    // were all absent from their export maps and all resolved fine in-repo
    // through the workspace symlink. A rule that cannot see the import style a
    // package actually uses is not a rule.
    const IMPORT = new RegExp("(?:from|import\\()\\s*'(@bakery/[^']+)'", 'g')
    const offenders: string[] = []
    for (const file of allSources) {
      for (const [, spec] of file.text.matchAll(IMPORT)) {
        const pkg = spec.split('/').slice(0, 2).join('/')
        const map = maps[pkg]
        if (!map) continue
        const entry = spec === pkg ? '.' : `.${spec.slice(pkg.length)}`
        if (!map.has(entry)) offenders.push(`${file.path}  ${spec}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
