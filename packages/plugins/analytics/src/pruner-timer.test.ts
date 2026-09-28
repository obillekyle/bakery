const SEP = String.fromCharCode(92)
import { describe, expect, test } from 'bun:test'

/**
 * A process that records one page hit must still be able to exit.
 *
 * `ensurePageHitsLogPruner` installs a 60-second `setInterval` on the *first*
 * recorded page hit, so any process that serves one ordinary request held the
 * event loop open for ever - a script that imports the plugin and finishes its
 * work simply never returned. Same class as the three core timers unref'd
 * earlier; this one lives in a plugin and was outside what that pass covered.
 *
 * Asserted by consequence rather than by inspecting the handle: a timer that
 * claims to be unref'd and is not would pass an `unref` check and hang here.
 */
describe('the analytics pruner does not pin the event loop', () => {
  test(
    'a process that records a page hit exits',
    async () => {
      const modulePath = JSON.stringify(
        import.meta.dir.split(SEP).join('/') + '/core.ts',
      )
      const script = [
        'const core = await import(' + modulePath + ')',
        "core.recordRouteHit('GET', '/a-real-page')",
        "core.recordRouteHit('GET', '/another')",
      ].join('; ')

      const proc = Bun.spawn(['bun', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: process.cwd(),
      })

      const exited = await Promise.race([
        proc.exited,
        new Promise<'timeout'>(resolve =>
          setTimeout(() => resolve('timeout'), 20_000),
        ),
      ])

      if (exited === 'timeout') {
        proc.kill()
        throw new Error(
          'the process did not exit within 20s: a timer holds the loop open',
        )
      }

      expect(exited).toBe(0)
    },
    30_000,
  )
})
