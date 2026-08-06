import { unlinkSync } from 'node:fs'
import { Try } from '../utils/common/try'

export const PromptTracker = {
  getFilePath(pid: number): string {
    return `.bakery/cache/.prompt-active-${pid}`
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
