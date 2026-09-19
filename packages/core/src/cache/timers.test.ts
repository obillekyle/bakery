import { describe, expect, test } from 'bun:test'
import { fs } from '../utils'

/**
 * Importing the framework must not stop a process from exiting.
 *
 * Three module-level `setInterval`s hold the event loop by default: the
 * session tier's flush (`cache/tiered.ts`), the string cache's flush
 * (`cache/string.ts`, constructed at module scope by `compiler/compiler.ts`)
 * and the session prune (`session.ts`). None of them is a reason to keep a
 * process alive — a flush that never runs because the process is ending is
 * exactly correct — but every one of them kept it alive anyway.
 *
 * The CLI never noticed: every one of its paths ends in `process.exit`. What
 * it cost was everything else. A script, a test harness or anything embedding
 * `@bakery-framework/core` printed its answer and then sat there until it was
 * killed, with nothing to indicate why.
 *
 * **Asserted by spawning, because that is the actual claim.** Checking a
 * timer's `hasRef()` would test the call rather than the consequence, and the
 * consequence — this process ends on its own — is the thing that was broken.
 * A timeout here means a fourth timer arrived, or an existing one lost its
 * `unref`.
 */
describe('importing core does not pin the event loop', () => {
  const entries = [
    ['the session module', './session'],
    ['the compiler, which builds the string cache at module scope', './compiler/compiler'],
    ['the root barrel', './core/index'],
  ] as const

  for (const [label, specifier] of entries) {
    test(`a process importing ${label} exits on its own`, async () => {
      const probe = fs.resolve(
        import.meta.dir,
        `../.timer-probe-${specifier.replace(/[^a-z]/gi, '')}.ts`,
      )
      await Bun.write(probe, `import '${specifier}'\n`)

      try {
        const child = Bun.spawn(['bun', probe], { stdout: 'ignore', stderr: 'ignore' })

        // Generous: a cold import of the barrel is ~100 ms on this machine, and
        // the failure mode is an infinite hang rather than a slow exit, so the
        // bound only has to be shorter than a person's patience.
        const timeout = new Promise<'timeout'>(resolve =>
          setTimeout(() => resolve('timeout'), 20_000),
        )
        const outcome = await Promise.race([child.exited, timeout])

        if (outcome === 'timeout') child.kill()
        expect(`${label}: ${outcome === 'timeout' ? 'hung' : 'exited'}`).toBe(
          `${label}: exited`,
        )
      } finally {
        await fs.rm(probe)
      }
    }, 30_000)
  }
})
