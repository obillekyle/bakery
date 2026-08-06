import { Bakery } from '../../core/bakery'
import { FileSystem } from '../../utils/fs'
import { checkCsrf, response } from '../../utils/http'
import type { Handler, Route } from '../core/$base'
import { DynamicHandler } from '../core/$dynamic'
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

    return result ?? response.error('No response from handler')
  }

  static async executeModule(
    file: FileSystem.AbsolutePath,
    req: Request,
    body: any,
  ): Promise<any> {
    // The `?v=<mtime>` suffix makes Bun's module registry treat every edit as
    // a new module, which is what gives DEV edit-and-refresh. It also costs a
    // stat + string alloc per request and permanently retains each superseded
    // module — acceptable in DEV, pure waste in PROD where route files cannot
    // change. So PROD imports the bare specifier once and serves from the
    // registry cache; the trade is that PROD needs a restart to pick up
    // changed route files, which is already true operationally since PROD
    // runs no watcher. `&& !TEST` is load-bearing: init.ts defaults PROD to
    // true whenever `--dev` is absent, and `bun test` loads init via the CLI
    // package's tests — so a bare PROD gate flipped mid-suite and broke the
    // reload tests in files loaded after it, while passing in isolation.
    if (import.meta.env.PROD && !import.meta.env.TEST) {
      return super.executeModule(file, req, body)
    }

    return super.executeModule(
      `${file}?v=${Bun.file(file).lastModified}` as FileSystem.AbsolutePath,
      req,
      body,
    )
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
