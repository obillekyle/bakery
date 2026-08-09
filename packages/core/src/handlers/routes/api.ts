import { Bakery } from '../../core/bakery'
import { handlerLog } from '../../logger/serve-log'
import { FileSystem } from '../../utils/fs'
import { checkCsrf, response } from '../../utils/http'
import type { Handler } from '../core/$base'
import { bustInDev, DynamicHandler } from '../core/$dynamic'
import { ErrorHandler } from '../core/$error'

export class ApiHandler extends DynamicHandler {
  /** Executes a module and returns its value; never file bytes. See `Handler.servesFiles`. */
  static servesFiles = false

  static canHandle(path: string) {
    return path.startsWith('/api/')
  }

  static get config() {
    return {
      ext: ['ts', 'js'],
      dir: Bakery.apiRoot,
    }
  }

  static resolveRoute(path: string) {
    path = path.slice(4) // remove api prefix
    return super.resolveRoute(path)
  }

  static async handle(path: string, req: Request) {
    // State-changing methods must be same-origin. SameSite=Lax alone does not
    // cover this: a cross-site form POST is a CORS-simple request.
    const url: URL = (req as any).__parsedUrl || new URL(req.url)
    const csrf = checkCsrf(req, url)
    if (csrf) return response.json.error(403, csrf) as unknown as Response

    const info = await this.resolveRoute(path)
    if (!info) return response.error('No API handler found')

    const cleanPath = path.slice(4)
    const params = info.getParams(cleanPath) || {}
    const body = await this.params(req, params)

    const filePath = FileSystem.resolve(this.config.dir, info.path)
    const result = await this.executeModule(filePath, req, body)

    if (result !== null && result !== undefined) return result

    // Two different faults used to share one bare 404, and neither channel
    // named the file — so "No response from handler" sent the developer
    // hunting for a route that was sitting on disk the whole time.
    //
    // `null` and `undefined` are what tell them apart, and the split is exact
    // rather than incidental: `DynamicHandler.executeModule` *throws* when the
    // import fails (that is the 500 path), returns a literal `null` for
    // "module loaded, no `default`", and otherwise returns whatever the
    // handler produced — `undefined` when it produced nothing.
    if (result === null) {
      // A 500, not a 404: the route resolved, the file exists, and the server
      // could not answer with it. That is a server fault, and the message says
      // what to add. PROD still redacts it — `publicBody` replaces any 5xx
      // body — so naming the file here discloses nothing to a client.
      handlerLog.API_NO_DEFAULT({ file: filePath })
      return response.error(
        `API route has no export default: ${info.path}`,
        500,
      )
    }

    handlerLog.API_NO_RESPONSE({ file: filePath })
    return response.error('No response from handler')
  }

  static async executeModule(
    file: FileSystem.AbsolutePath,
    req: Request,
    body: any,
  ): Promise<any> {
    // See `bustInDev` for why the suffix exists and why `!TEST` is part of the
    // gate. `TSXHandler` applies the same rule through the same helper.
    return super.executeModule(bustInDev(file), req, body)
  }
}

export class ApiErrorHandler extends ErrorHandler {
  static canHandle(path: string) {
    return path.startsWith('/api/')
  }

  static handle(_p: string, _r: Request, error: Handler.Error.Data) {
    // `publicBody`, not `errorBody`: in production the latter is the stack of
    // whatever threw. The full trace still reaches the log — `handleRequestError`
    // passes the unredacted data to `config.onError` before this runs.
    return response.json.error(error.errorCode, ErrorHandler.publicBody(error))
  }
}
