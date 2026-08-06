import { Bakery } from '../core/bakery'
import { fs } from '../utils/fs'
import { parseJSONC } from '../utils/jsonc'
import { errorMsg, serveLog } from '../logger'
import type { MapOf } from '../types'

// 🚀 Hoisted Regexes
const RE_ROOT_RELATIVE = /^(\.\/)?(\.server|api|node_modules)\//
const RE_HTTP = /^https?:\/\//
const RE_LEADING_SLASHES = /^(\.\/|\/)/
const RE_RELATIVE = /^\.\.?\//
const RE_TRAILING_WILDCARD = /\/?\*?$/

// The application's tsconfig, resolved against its cwd. This used to write into
// a tsconfig *inside the framework* — app-specific paths mutating a shipped
// package file, which is also why running the test suite dirtied the tree.
const APP_CONFIG_PATH = fs.resolve(process.cwd(), 'tsconfig.json')
const APP_DIR = process.cwd()

function buildPaths(): MapOf<string[]> {
  const newPaths: MapOf<string[]> = {}

  for (const [key, val] of Object.entries(Bakery.config.importMap)) {
    if (RE_HTTP.test(val)) continue
    // Values the server maps to a served URL ('/_client/utils.js') are not
    // filesystem paths; turning them into tsconfig paths yields a directory
    // that does not exist. Their type mapping belongs in tsconfig.base.json.
    if (val.startsWith('/')) continue

    const isDir = key.endsWith('/')
    const tsKey = isDir ? `${key.slice(0, -1)}/*` : key

    const absolutePath = RE_ROOT_RELATIVE.test(val)
      ? fs.resolve(Bakery.root, val)
      : fs.resolve(Bakery.serveRoot, val.replace(RE_LEADING_SLASHES, ''))

    const relativePath = fs.relative(APP_DIR, absolutePath)

    let tsVal = (RE_RELATIVE.test(relativePath) ? '' : './') + relativePath
    if (isDir) tsVal = tsVal.replace(RE_TRAILING_WILDCARD, '/*')

    newPaths[tsKey] = [tsVal]
  }

  return newPaths
}

export async function syncTSConfigPaths(): Promise<void> {
  try {
    const newPaths = buildPaths()
    let appConfig: any = { compilerOptions: { paths: {} } }

    if (fs.exists(APP_CONFIG_PATH)) {
      appConfig = parseJSONC(await Bun.file(APP_CONFIG_PATH).text())
    }

    appConfig.compilerOptions ??= {}
    delete appConfig.compilerOptions.baseUrl

    const currentPaths = appConfig.compilerOptions.paths ?? {}

    if (Bun.deepEquals(currentPaths, newPaths)) return

    appConfig.compilerOptions.paths = newPaths
    await Bun.write(APP_CONFIG_PATH, JSON.stringify(appConfig, null, 2))

    serveLog.TSCONFIG_SYNCED()
  } catch (err: any) {
    serveLog.UNHANDLED_ERR({ error: `TSConfig sync error: ${errorMsg(err)}` })
  }
}
