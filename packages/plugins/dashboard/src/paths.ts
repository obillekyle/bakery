import { fs } from '@bakery/core/utils'

/**
 * Where this plugin's own files live.
 *
 * Not `frameworkPath()` — that anchors to `@bakery/core`, so once the dashboard
 * became its own package every asset lookup pointed into core and 404'd. Each
 * package that ships files needs its own anchor, derived from its own location.
 */
export const pluginRoot: string = fs.resolve(import.meta.dir)

export function pluginPath(...segments: string[]): string {
  return fs.resolve(pluginRoot, ...segments)
}
