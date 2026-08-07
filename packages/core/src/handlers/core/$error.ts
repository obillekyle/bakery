import { errorDetail } from '../../logger/serve-log'
import type { MapOf, MixedPromise } from '../../types'
import { is } from '../../utils/common'
import { fs } from '../../utils/fs'
import { response } from '../../utils/http'
import { Handler } from './$base'
import { DynamicHandler } from './$dynamic'

const DEFAULT_ERROR: Handler.Error.Data = {
  errorCode: 500,
  errorText: 'Internal Server Error',
  errorBody: 'An unexpected error occurred.',
}

/**
 * A fresh copy of the process-wide default error data.
 *
 * The copy is the point, not the convenience. `extractErrorData` assigns the
 * getter's result to a local and then *mutates* it, which is safe only while
 * every `this` it runs under hands back a new object — a plain
 * `= DEFAULT_ERROR` would let any caller write the process-wide default's
 * fields. Both `ErrorHandler` and `DynamicErrorHandler` need the getter and
 * they sit in different class hierarchies, so neither can inherit it from the
 * other; they call this instead of each keeping a copy of the copy.
 */
function defaultErrorData(): Handler.Error.Data {
  return Object.assign({}, DEFAULT_ERROR)
}

/**
 * The three lines every page handler opens with: the error-data default, the
 * route lookup, and the 404 for a path that resolves to nothing.
 *
 * `HTMLHandler`, `TSXHandler` and the Vue plugin's handler render three
 * different file formats and their bodies genuinely differ — but all three
 * reach them this way. `errors` is `undefined` for an ordinary page, and
 * `DEFAULT_ERROR` exists only on the error subclasses, so the fallback stays
 * `undefined` for the ordinary handlers. `DynamicErrorHandler.resolveRoute`
 * uses the second argument to prefer `error-<code>` over `error`;
 * `DynamicHandler.resolveRoute` ignores it.
 *
 * Hands back the 404 `Response` itself rather than a `null` the caller has to
 * remember to turn into one.
 */
export async function beginPageRoute(
  handler: typeof DynamicHandler | typeof DynamicErrorHandler,
  path: string,
  errors?: Handler.Error.Data,
): Promise<
  | { errorData: Handler.Error.Data | undefined; info: Handler.Route.Info }
  | Response
> {
  const errorData = errors || (handler as any).DEFAULT_ERROR
  const info = await handler.resolveRoute(path, errorData)
  if (!info) return response.error('Not Found')
  return { errorData, info }
}

/**
 * Stamp the DEV-only `__file` marker onto a page's params.
 *
 * One spelling of one rule: the marker goes on the params object **before**
 * whatever error data gets merged in, and it names the route-relative path.
 * `HTMLHandler` used to set it after the merge and `TSXHandler` before, which
 * comes out the same today only because `publicErrorData` never emits a
 * `__file` key — two orderings for one rule is what makes it look like the
 * order might matter. It does not; this is the order, and `params` is the
 * object because TSX also feeds that same object to `injectIfHtml`.
 */
export function markDevFile(params: MapOf<any>, routePath: string): void {
  if (import.meta.env.DEV) params.__file = routePath
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
  /** A fresh copy every read — see `defaultErrorData`. */
  static get DEFAULT_ERROR() {
    return defaultErrorData()
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
   * The same fresh copy `ErrorHandler.DEFAULT_ERROR` hands back — see
   * `defaultErrorData`. Declared again rather than inherited because this
   * class descends from `DynamicHandler`, not from `ErrorHandler`.
   */
  static get DEFAULT_ERROR() {
    return defaultErrorData()
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
