import { AsyncLocalStorage } from 'node:async_hooks'
import { fs } from '@server/utils/fs'

export type HostContext = {
  config: Readonly<ProcessedAppConfig>
  hostname: string
}

export const hostStore = new AsyncLocalStorage<HostContext>()

let _bakeryVersion: string | null = null
export function getBakeryVersion() {
  if (_bakeryVersion) return _bakeryVersion
  try {
    const content = fs.readFileSync(fs.resolve(fs.cwd, 'package.json'))
    if (content) _bakeryVersion = JSON.parse(content).version || '1.0.0'
  } catch {}
  return _bakeryVersion || '1.0.0'
}
