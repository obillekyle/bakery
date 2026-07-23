import { Bakery } from '@server/core/bakery'
import { FileSystem } from '@server/utils/fs'
import { response } from '@server/utils/http'
import type { Handler, Route } from '../core/$base'
import { DynamicHandler } from '../core/$dynamic'
import { ErrorHandler } from '../core/$error'

export class ApiHandler extends DynamicHandler {
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
    const info = await this.resolveRoute(path)
    if (!info) return response.error('No API handler found')

    const cleanPath = path.slice(4)
    const params = info.getParams(cleanPath) || {}
    const body = await this.params(req, params)

    const filePath = FileSystem.resolve(this.config.dir, info.path)
    const result = await this.executeModule(filePath, req, body)

    return result ?? response.error('No response from handler')
  }
}

export class ApiErrorHandler extends ErrorHandler {
  static canHandle(path: string) {
    return path.startsWith('/api/')
  }

  static handle(_p: string, _r: Request, error: Handler.Error.Data) {
    return response.json.error(error.errorCode, error.errorBody)
  }
}
