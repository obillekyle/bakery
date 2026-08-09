import { Bakery } from '../../core/bakery'
import { isSafeHtml } from '../../core/jsx'
import type { MapOf, MixedPromise } from '../../types'
import { is, jsonResponse } from '../../utils/common'
import { fs } from '../../utils/fs'
import { injectIfHtml, response } from '../../utils/http'
import type { Handler } from '../core/$base'
import { bustInDev, DynamicHandler } from '../core/$dynamic'
import {
  beginPageRoute,
  DynamicErrorHandler,
  markDevFile,
  publicErrorData,
} from '../core/$error'

export class TSXHandler extends DynamicHandler {
  static get config() {
    return {
      ext: ['tsx'],
      dir: Bakery.serveRoot,
    }
  }

  static handle = sharedHandler

  static executeModule(file: fs.AbsolutePath, req: Request, body: any) {
    return super.executeModule(bustInDev(file), req, body)
  }
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

  static executeModule(file: fs.AbsolutePath, req: Request, body: any) {
    return super.executeModule(bustInDev(file), req, body)
  }
}

//
//
async function sharedHandler(
  this: typeof DynamicHandler | typeof DynamicErrorHandler,
  path: string,
  req: Request,
  errors?: Handler.Error.Data,
) {
  const begun = await beginPageRoute(this, path, errors)
  if (begun instanceof Response) return begun
  const { errorData, info } = begun
  const filePath = info.path

  const modulePath = fs.resolve(Bakery.serveRoot, filePath)
  const params = info.getParams(path) || {}
  markDevFile(params, filePath)
  // Redacted before it becomes page data — see `publicErrorData`. The params
  // are both substituted into the render and injected as `__PAGE_PARAMS__`.
  // `errorData` is undefined for an ordinary page; Object.assign ignores that.
  const finalParams = Object.assign(
    {},
    params,
    errorData && publicErrorData(errorData),
  )
  const body = await this.params(req, finalParams)

  const returned = await this.executeModule(modulePath, req, body)
  if (returned === null) return response.error('Not Found')

  // `createElement` returns `raw()` → a SafeHtml, which is a String
  // *subclass*, so `is.object` (typeof === 'object') is true for it and an
  // unwrapped JSX page got JSON-encoded instead of served as HTML. Unbox it
  // here rather than widening `is.object`: `is.object([]) === true` is a
  // deliberate decision that router.ts depends on.
  const resData = isSafeHtml(returned) ? String(returned) : returned

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

  const html = await injectIfHtml(resData, params, {
    body: hasTs ? `<script src="/${tsUrl}" type="module"></script>` : '',
    head: hasCss ? `<link rel="stylesheet" href="/${style}">` : '',
  })
  if (html) return html

  return is.string(resData)
    ? response.text(resData)
    : response.error('Not Found')
}
