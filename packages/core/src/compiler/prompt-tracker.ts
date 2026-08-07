import { unlinkSync } from 'node:fs'
import { Bakery } from '../core/bakery'
import { Try } from '../utils/common/try'

export const PromptTracker = {
  getFilePath(pid: number): string {
    // Derived, not written out: this lands in the cache directory, which the
    // framework wipes wholesale, and a stale literal here would leave marker
    // files behind in a directory nothing sweeps.
    return `${Bakery.cacheDir}/.prompt-active-${pid}`
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
        Bun.file(this.getFilePath(pid)).delete().catch(() => {})
      }
    })
  },
}
