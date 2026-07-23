import { Bakery } from '@server/core/bakery'
import { is, jsonResponse } from '@server/utils/common'
import { fs } from '@server/utils/fs'
import { injectIfHtml, response } from '@server/utils/http'
import type { Handler } from '../core/$base'
import { DynamicHandler } from '../core/$dynamic'
import { DynamicErrorHandler } from '../core/$error'

type TSXModule = {
  default: (
    req: Request,
    body: MapOf<any>,
  ) => MixedPromise<string | Response | MapOf<any>>
}

export class TSXHandler extends DynamicHandler {
  static get config() {
    return {
      ext: ['tsx'],
      dir: Bakery.serveRoot,
    }
  }

  static handle = sharedHandler
}

export class TSXErrorHandler extends DynamicErrorHandler {
  static get config() {
    return {
      ext: ['tsx'],
      dir: Bakery.serveRoot,
      include: ['**/error.tsx', '**/error-*.tsx'],
    }
  }

  static handle = sharedHandler
}

//
//
async function sharedHandler(
  this: typeof DynamicHandler | typeof DynamicErrorHandler,
  path: string,
  req: Request,
  errors?: Handler.Error.Data,
) {
  const errorData = errors || (this as any).DEFAULT_ERROR
  const info = await this.resolveRoute(path, errorData)
  if (!info) return response.error('Not Found')
  const filePath = info.path

  const modulePath = fs.resolve(Bakery.serveRoot, filePath)
  const params = info.getParams(path) || {}
  if (import.meta.env.DEV) {
    params.__file = filePath
  }
  const finalParams = Object.assign({}, params, errorData)
  const body = await this.params(req, finalParams)

  const resData = await this.executeModule(modulePath, req, body)
  if (resData === null) return response.error('Not Found')

  const code = errorData?.errorCode || 200
  if (is.object(resData)) {
    return resData instanceof Response
      ? resData
      : jsonResponse(code, 'Success', resData)
  }

  const [hasTs, hasCss] = await Promise.all([
    fs.exists(modulePath.replace(/\.tsx$/, '.ts')),
    fs.exists(modulePath.replace(/\.tsx$/, '.css')),
  ])

  const style = filePath.replace(/\.tsx$/, '.css')
  const tsUrl = filePath.replace(/\.tsx$/, '.js')

  params.$$body = hasTs ? `<script src="/${tsUrl}" type="module"></script>` : ''
  params.$$head = hasCss ? `<link rel="stylesheet" href="/${style}">` : ''

  const html = await injectIfHtml(resData, params)
  if (html) return html

  return is.string(resData)
    ? response.text(resData)
    : response.error('Not Found')
}
