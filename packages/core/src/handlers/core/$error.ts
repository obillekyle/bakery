import { errorDetail } from '../../logger/serve-log'
import type { MixedPromise } from '../../types'
import { is } from '../../utils/common'
import { fs } from '../../utils/fs'
import { Handler } from './$base'
import { DynamicHandler } from './$dynamic'

const DEFAULT_ERROR: Handler.Error.Data = {
  errorCode: 500,
  errorText: 'Internal Server Error',
  errorBody: 'An unexpected error occurred.',
}

export class HandlerError extends Error {
  data: Handler.Error.Data
  request?: Request = undefined

  static getDefaultData() {
    return DEFAULT_ERROR
  }

  constructor(
    message?: string,
    req?: Request,
    data?: Partial<Handler.Error.Data>,
  ) {
    const finalData = {
      ...HandlerError.getDefaultData(),
      ...data,
    }

    super(message || finalData.errorText || 'Handler Error')
    this.data = finalData as Handler.Error.Data
    this.request = req
  }
}

export class ErrorHandler extends Handler {
  static get DEFAULT_ERROR() {
    return Object.assign({}, DEFAULT_ERROR)
  }

  static isError(error: any): boolean {
    if (error instanceof Response) return error.status >= 400
    if (error instanceof HandlerError) return true
    if (is.object(error)) {
      if ('errorCode' in error && is.number(error.errorCode)) {
        return error.errorCode >= 400
      }
    }

    return false
  }

  static canHandle(
    path: string,
    req: Request,
    errors?: Handler.Error.Data,
  ): MixedPromise<boolean>
  static canHandle() {
    return true
  }

  static handle(
    path: string,
    req: Request,
    errors?: Handler.Error.Data,
  ): Handler.Response
  static handle() {}

  /**
   * The part of `error` that may cross the wire.
   *
   * `extractErrorData` puts `error.stack` into `errorBody` deliberately — that
   * is what reaches the server log, and losing it would be a regression. But
   * the same field was being handed straight to the client: a `SQLiteError`
   * from a failed query answered a 500 with the failing statement, the table
   * and column names, and absolute paths into the source tree.
   *
   * So the redaction belongs at the boundary, not at extraction. 5xx is the
   * only band `extractErrorData` ever fills from a thrown `Error`, and
   * therefore the only one whose body can be a stack; a 4xx body is authored
   * by whoever constructed the `HandlerError` or the `Response` and is theirs
   * to disclose.
   */
  static publicBody(error: Handler.Error.Data): string {
    if (import.meta.env.DEV) return error.errorBody
    return error.errorCode >= 500 ? DEFAULT_ERROR.errorBody : error.errorBody
  }

  /**
   * Whether `error` is one of Bun's compile-time diagnostics.
   *
   * `BuildMessage` (a syntax error) and `ResolveMessage` (an import that
   * resolves to nothing) are what the transpiler and the module resolver throw,
   * and neither is `instanceof Error`. They used to reach the `is.object`
   * branch below, which reads only `errorCode`/`errorText`/`errorBody` — none
   * of which a diagnostic has — and so returned the untouched default. A typo
   * in a route file, the single most common server-side failure there is,
   * answered `An unexpected error occurred.` in development as well as in
   * production.
   *
   * Recognised by shape rather than by constructor: the classes are not
   * exported, and both report zero own enumerable keys, so a string `message`
   * on a non-`Error` object is the only tell. The error-data keys are checked
   * first by the caller, so a record that carries those still takes its own
   * branch.
   */
  static isDiagnostic(error: any): boolean {
    if (!is.object(error)) return false
    if (error instanceof Error || error instanceof Response) return false
    return is.string(error.message) && error.message.length > 0
  }

  static extractErrorData(error: any): Handler.Error.Data {
    if (error instanceof HandlerError) return error.data

    if (error instanceof Error) {
      return {
        ...this.DEFAULT_ERROR,
        errorText: error.message,
        // `errorDetail` is `error.stack` whenever there is one — so the common
        // case is untouched — and falls back to the aggregated sub-diagnostics
        // for the stackless `AggregateError` that `import()`ing a broken `.tsx`
        // throws, where `String(error)` was a summary count and nothing else.
        errorBody: errorDetail(error) || String(error),
      }
    }

    if (error instanceof Response) {
      return {
        ...this.DEFAULT_ERROR,
        errorCode: error.status,
        errorText: error.statusText,
        errorBody: `${error.status}: "${error.statusText}"`,
      }
    }

    if (is.object(error)) {
      const errorObj = error as Partial<Handler.Error.Data>
      const authored =
        errorObj.errorCode !== undefined ||
        errorObj.errorText !== undefined ||
        errorObj.errorBody !== undefined

      // Authored error data wins, `message` or no `message` — the branch order
      // and its semantics are unchanged for everything that ever reached it.
      if (!authored && this.isDiagnostic(error)) {
        return {
          ...this.DEFAULT_ERROR,
          errorText: error.message,
          errorBody: errorDetail(error),
        }
      }

      const errorData = this.DEFAULT_ERROR

      errorData.errorCode = errorObj.errorCode ?? errorData.errorCode
      errorData.errorText = errorObj.errorText ?? errorData.errorText
      errorData.errorBody = errorObj.errorBody ?? errorData.errorBody
      return errorData
    }

    if (is.string(error)) {
      return { ...this.DEFAULT_ERROR, errorText: error }
    }

    return this.DEFAULT_ERROR
  }
}

export class DynamicErrorHandler extends DynamicHandler {
  /**
   * A copy, matching `ErrorHandler.DEFAULT_ERROR` above. `extractErrorData`
   * assigns this to a local and then mutates it, which is safe only while
   * every `this` it runs under hands back a fresh object — a plain
   * `= DEFAULT_ERROR` here handed out the module-level one, so any class
   * inheriting that method through this branch would have written the
   * process-wide default's fields.
   */
  static get DEFAULT_ERROR() {
    return Object.assign({}, DEFAULT_ERROR)
  }

  static canHandle(
    path: string,
    req: Request,
    errors?: Handler.Error.Data,
  ): MixedPromise<boolean>
  static async canHandle(path: string, _: any, errors?: Handler.Error.Data) {
    return Boolean(await this.resolveRoute(path, errors))
  }

  static handle(
    path: string,
    req: Request,
    errors?: Handler.Error.Data,
  ): Handler.Response

  static handle(path: string, req: Request, errors?: Handler.Error.Data) {
    return (super.handle as any)(path, req, errors)
  }

  static async resolveRoute(path: string, errors?: Handler.Error.Data) {
    errors ||= this.DEFAULT_ERROR

    const parsed = fs.parse(path)
    const pathArray = parsed.dir.split('/').filter(Boolean)

    for (let i = pathArray.length; i >= 0; i--) {
      const prefix = i ? `/${pathArray.slice(0, i).join('/')}` : ''

      const defsPage = `${prefix}/error`
      const codePage = `${prefix}/error-${errors.errorCode}`
      const routeInfo =
        (await super.resolveRoute(codePage)) ||
        (await super.resolveRoute(defsPage))
      if (routeInfo) return routeInfo
    }

    return null
  }
}

/**
 * Error data with `errorBody` reduced to what a client may see.
 *
 * `ErrorHandler.publicBody` is the rule; this is it applied to a whole record,
 * for the handlers that hand error data to a *template* rather than rendering
 * a string themselves. `HTMLErrorHandler` and `TSXErrorHandler` merge the
 * record into their page params, and those params reach the document twice —
 * through `{{...}}` substitution and through the `window.__PAGE_PARAMS__`
 * script `DOMTools.params` injects into every page. The second path is why
 * redacting in the template was never enough: an `error.html` that never
 * mentions `errorBody` still published the stack, absolute source paths and
 * all, to any anonymous request in production.
 *
 * `errorText` is deliberately untouched — `DefaultErrorHandler` shows it in
 * its heading in every mode, and one rule in one place beats two that drift.
 */
export function publicErrorData(error: Handler.Error.Data): Handler.Error.Data {
  return { ...error, errorBody: ErrorHandler.publicBody(error) }
}
