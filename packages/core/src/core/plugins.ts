import { Bakery } from './bakery'
import type { Handler } from '../handlers'
import { is } from '../utils/common'
import { injectIfHtml, response } from '../utils/http'
import { errorMsg, pluginLog, serveLog } from '../logger'
import { Try } from '../utils'

function getPlugins() {
  return Bakery.config.plugins
}

async function normalizePluginResult(result: Handler.Response) {
  if (result instanceof Response) {
    const injectedRes = await injectIfHtml(result)
    return injectedRes || result
  }

  if (result !== undefined && result !== null) {
    return is.object(result)
      ? response.json(200, 'OK', result)
      : response.text(String(result))
  }

  return null
}

export namespace PluginHooks {
  export async function setup() {
    for (const plugin of getPlugins()) {
      const [err] = await Try.catch(() => plugin.setup?.(Bakery.config))
      if (err) {
        serveLog.UNHANDLED_ERR({
          error: `Plugin setup error (${plugin.name}): ${errorMsg(err)}`,
        })
      }
    }
  }

  export async function onRequest(req: Request) {
    for (const plugin of getPlugins()) {
      const [err, result] = await Try.catch(plugin.onRequest?.(req))
      if (err) {
        serveLog.UNHANDLED_ERR({
          error: `Plugin request error (${plugin.name}): ${errorMsg(err)}`,
        })
        return response.json.error(
          500,
          'Internal Server Error',
        ) as unknown as Response
      }

      const normalized = await normalizePluginResult(result)
      if (normalized) return normalized
    }
    return null
  }

  export async function onRoute(req: Request) {
    for (const plugin of getPlugins()) {
      const [err] = await Try.catch(() => plugin.onRoute?.(req))

      if (err) {
        pluginLog.UNHANDLED_ERR({ error: `${plugin.name}: ${errorMsg(err)}` })
      }
    }
  }

  export async function onStart(server: any) {
    for (const plugin of getPlugins()) {
      const [err] = await Try.catch(() => plugin.onStart?.(server))

      if (err) {
        pluginLog.UNHANDLED_ERR({ error: `${plugin.name}: ${errorMsg(err)}` })
      }
    }
  }

  export async function onError(error: Handler.Error.Data, req?: Request) {
    for (const plugin of getPlugins()) {
      if (!plugin.onError) continue
      const [err, result] = await Try.catch(() => plugin.onError!(error, req))

      if (err) {
        pluginLog.UNHANDLED_ERR({ error: `${plugin.name}: ${errorMsg(err)}` })
        continue
      }

      const normalized = await normalizePluginResult(result)
      if (normalized) return normalized
    }
    return null
  }

  export async function onShutdown() {
    for (const plugin of getPlugins()) {
      const [err] = await Try.catch(() => plugin.onShutdown?.())
      if (err) {
        pluginLog.UNHANDLED_ERR({ error: `${plugin.name}: ${errorMsg(err)}` })
      }
    }
  }

  export async function onCompile(content: string, path: string): Promise<string> {
    for (const plugin of getPlugins()) {
      if (!plugin.onCompile) continue
      const [err, res] = await Try.catch(() => plugin.onCompile!(content, path))
      if (err) {
        pluginLog.UNHANDLED_ERR({ error: `${plugin.name}: ${errorMsg(err)}` })
        continue
      }
      if (typeof res === 'string') {
        content = res
      }
    }
    return content
  }
}
