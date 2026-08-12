import { unlinkSync } from 'node:fs'
import { cacheDir } from '../core/context'
import { Try } from '../utils/common/try'

/**
 * **`cacheDir` comes from `core/context`, not from `Bakery` — do not change it
 * back.** `logger.ts` imports this module, so importing `core/bakery` here
 * completed a cycle:
 *
 *     logger.ts -> prompt-tracker.ts -> core/bakery.ts -> core/config.ts
 *       -> logger/serve-log.ts -> logger.ts
 *
 * `serve-log.ts` runs `new Logger('serve')` at module scope, so whichever
 * import arrived first found `Logger` still in its temporal dead zone. That
 * shipped in 1.2.3 and made `import '@bakery-framework/core'` throw
 * `ReferenceError: Cannot access 'Logger' before initialization` from a clean
 * install — see `tests/module-cycle.test.ts`.
 *
 * `core/context` holds the same single definition of the path and imports
 * nothing that reaches the logger.
 */
export const PromptTracker = {
  getFilePath(pid: number): string {
    // Derived, not written out: this lands in the cache directory, which the
    // framework wipes wholesale, and a stale literal here would leave marker
    // files behind in a directory nothing sweeps.
    return `${cacheDir()}/.prompt-active-${pid}`
  },

  async isActive(pid: number): Promise<boolean> {
    return (
      (await Promise.try(() => Bun.file(this.getFilePath(pid)).exists()).catch(
        () => false,
      )) ?? false
    )
  },

  activate(pid: number): void {
    Try(() => Bun.write(this.getFilePath(pid), '1'))
  },

  deactivate(pid: number): void {
    Try(() => {
      try {
        unlinkSync(this.getFilePath(pid))
      } catch {
        Bun.file(this.getFilePath(pid))
          .delete()
          .catch(() => {})
      }
    })
  },
}
