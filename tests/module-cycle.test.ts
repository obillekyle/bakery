import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

/**
 * Core's public entry points must be importable **first**, in a cold process.
 *
 * `@bakery-framework/core@1.2.3` was not. `logger/serve-log.ts` runs
 * `new Logger('serve')` at module scope, and this cycle —
 *
 *     logger.ts -> compiler/prompt-tracker.ts -> core/bakery.ts
 *       -> core/config.ts -> logger/serve-log.ts -> logger.ts
 *
 * — meant that whichever import arrived first found `Logger` still in its
 * temporal dead zone. `import '@bakery-framework/core'` threw
 * `ReferenceError: Cannot access 'Logger' before initialization` from a clean
 * install, so every consumer's `server.config.ts` failed to load and the server
 * booted on built-in defaults: wrong port, no plugins, no hosts.
 *
 * **Nothing in the suite could see it, and the reason is why this file spawns
 * processes.** Inside an already-running test the modules are loaded in an order
 * that happens to work, and so is the CLI's — `core/init` first, subpaths after.
 * The failure needs a process whose *first* import is the entry under test.
 * `apps/example` and `apps/starter` both booted green throughout.
 *
 * One subprocess per entry point, for the same reason: a single process that
 * imported all four would only ever test the first.
 */
/**
 * Run from `apps/example`, because the repo root has no `@bakery-framework/*`
 * in `node_modules` and these have to be resolved the way a consumer resolves
 * them. The workspace symlink hides export-map problems, but not this one:
 * evaluation order is identical through a symlink and through an installed
 * tarball, which was confirmed against a `bun pm pack` install and against
 * `@bakery-framework/core@1.2.3` straight from npm.
 */
const CONSUMER = resolve(import.meta.dir, '..', 'apps', 'example')

/** Public entry points a consumer can legitimately import before anything else. */
const ENTRIES = [
  '@bakery-framework/core',
  '@bakery-framework/core/logger',
  '@bakery-framework/core/core/bakery',
  '@bakery-framework/core/utils',
  '@bakery-framework/orm',
]

async function importsCleanly(specifier: string) {
  const proc = Bun.spawn(
    ['bun', '-e', `await import(${JSON.stringify(specifier)})`],
    { cwd: CONSUMER, stdout: 'pipe', stderr: 'pipe' },
  )

  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])

  return { code, stderr }
}

describe('core is importable from a cold process', () => {
  for (const entry of ENTRIES) {
    test(`${entry} imports without a module cycle`, async () => {
      const { code, stderr } = await importsCleanly(entry)

      // Named explicitly rather than folded into the exit-code check: this is
      // the exact error the cycle produces, and a future cycle through a
      // different module-scope binding should read as the same failure.
      expect(stderr).not.toContain('before initialization')
      expect({ entry, code, stderr: stderr.slice(0, 400) }).toMatchObject({
        code: 0,
      })
    })
  }
})
