import { describe, test, expect } from 'bun:test'
import { ErrorHandler, HandlerError } from './$error'

describe('HandlerError', () => {
  test('constructs with default data', () => {
    const err = new HandlerError('test')
    expect(err.message).toBe('test')
    expect(err.data.errorCode).toBe(500)
    expect(err.data.errorText).toBe('Internal Server Error')
  })

  test('constructs with custom data', () => {
    const err = new HandlerError('oops', undefined, {
      errorCode: 404,
      errorText: 'Not Found',
    })
    expect(err.data.errorCode).toBe(404)
    expect(err.data.errorText).toBe('Not Found')
  })

  test('stores request reference', () => {
    const req = new Request('http://localhost/')
    const err = new HandlerError('test', req)
    expect(err.request).toBe(req)
  })
})

describe('ErrorHandler.extractErrorData', () => {
  test('extracts from HandlerError', () => {
    const handlerErr = new HandlerError('test', undefined, {
      errorCode: 404,
      errorText: 'Not Found',
    })
    const data = ErrorHandler.extractErrorData(handlerErr)
    expect(data.errorCode).toBe(404)
    expect(data.errorText).toBe('Not Found')
  })

  test('extracts from Error', () => {
    const err = new Error('something broke')
    const data = ErrorHandler.extractErrorData(err)
    expect(data.errorText).toBe('something broke')
    expect(data.errorCode).toBe(500)
  })

  test('extracts from Response', () => {
    const res = new Response('Not Found', {
      status: 404,
      statusText: 'Not Found',
    })
    const data = ErrorHandler.extractErrorData(res)
    expect(data.errorCode).toBe(404)
    expect(data.errorText).toBe('Not Found')
  })

  test('extracts from object with errorCode', () => {
    const data = ErrorHandler.extractErrorData({
      errorCode: 403,
      errorText: 'Forbidden',
      errorBody: 'denied',
    })
    expect(data.errorCode).toBe(403)
    expect(data.errorText).toBe('Forbidden')
  })

  test('extracts from string', () => {
    const data = ErrorHandler.extractErrorData('bad request')
    expect(data.errorText).toBe('bad request')
    expect(data.errorCode).toBe(500)
  })

  test('returns defaults for unknown input', () => {
    const data = ErrorHandler.extractErrorData(null)
    expect(data.errorCode).toBe(500)
  })
})

/**
 * The failures a developer hits most — a typo in a route file — are the ones
 * `extractErrorData` used to throw away.
 *
 * Bun's transpiler throws a `BuildMessage` and its resolver a `ResolveMessage`.
 * Neither is `instanceof Error`, neither has a `stack`, and both have no own
 * enumerable keys at all, so they fell through to the `is.object` branch, which
 * reads only `errorCode`/`errorText`/`errorBody` and therefore returned the
 * untouched default. Every syntax error and every bad import answered with
 * `An unexpected error occurred.` — in development too, where disclosure is the
 * entire point.
 *
 * These are built from the real transpiler rather than hand-rolled objects: the
 * shape is Bun's to change, and a literal that drifts from it would keep
 * passing while the branch it guards went dead again.
 */
const buildMessage = (source: string) => {
  try {
    new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  } catch (err: any) {
    return err
  }
  throw new Error('expected the transpiler to reject this source')
}

describe('ErrorHandler.extractErrorData — Bun diagnostics', () => {
  test('a transpiler BuildMessage keeps its message and its position', () => {
    const data = ErrorHandler.extractErrorData(
      buildMessage('export default function ( {'),
    )

    expect(data.errorCode).toBe(500)
    expect(data.errorText).toBe('Expected identifier but found end of file')
    expect(data.errorBody).toContain(
      'Expected identifier but found end of file',
    )
    // line:column is the whole reason to keep `position`.
    expect(data.errorBody).toContain(':1:27')
    expect(data.errorBody).not.toBe('An unexpected error occurred.')
  })

  test('a resolver ResolveMessage survives having no position', async () => {
    // Held in a variable rather than written inline: a literal specifier is a
    // compile error (TS2307), and the module has to be missing at *runtime*.
    const missing = './this-module-does-not-exist-zz'

    let caught: any
    try {
      await import(missing)
    } catch (err) {
      caught = err
    }

    expect(caught?.constructor?.name).toBe('ResolveMessage')
    expect(caught instanceof Error).toBe(false)

    const data = ErrorHandler.extractErrorData(caught)
    expect(data.errorCode).toBe(500)
    expect(data.errorText).toContain('this-module-does-not-exist-zz')
    expect(data.errorBody).toContain('this-module-does-not-exist-zz')
  })

  test('an AggregateError of BuildMessages lists every position', () => {
    // What `import()` of a broken .tsx throws: `instanceof Error`, so it took
    // the Error branch — but with no `stack` the branch fell back to
    // `String(error)`, which is the summary line ("4 errors building …") and
    // not one line number.
    const inner = [
      buildMessage('export default function ( {'),
      buildMessage('const x: = 1'),
    ]
    const aggregate = new AggregateError(inner, '2 errors building "page.tsx"')
    delete (aggregate as any).stack

    const data = ErrorHandler.extractErrorData(aggregate)
    expect(data.errorText).toBe('2 errors building "page.tsx"')
    expect(data.errorBody).toContain(
      'Expected identifier but found end of file',
    )
    expect(data.errorBody).toContain(':1:27')
  })

  test('an object that already carries error data is untouched', () => {
    // The `message` recognition must not shadow the existing branch: a plain
    // record with `errorCode`/`errorText`/`errorBody` still wins, `message`
    // and all.
    const data = ErrorHandler.extractErrorData({
      errorCode: 403,
      errorText: 'Forbidden',
      errorBody: 'denied',
      message: 'should not be read',
    })

    expect(data.errorCode).toBe(403)
    expect(data.errorText).toBe('Forbidden')
    expect(data.errorBody).toBe('denied')
  })
})

describe('ErrorHandler.publicBody — diagnostics are development-only', () => {
  test('production still answers a compile failure generically', () => {
    // The point of the branch above is DEV richness. A `BuildMessage` body
    // carries the failing source line and an absolute path into the tree, and
    // it is a 500 — so the 5xx redaction must cover it exactly as it covers a
    // stack.
    const data = ErrorHandler.extractErrorData(
      buildMessage('export default function ( {'),
    )

    expect(ErrorHandler.publicBody(data)).toBe('An unexpected error occurred.')
    expect(ErrorHandler.publicBody(data)).not.toContain('export default')
  })

  test('development gets the whole diagnostic', () => {
    const data = ErrorHandler.extractErrorData(
      buildMessage('export default function ( {'),
    )

    expect(asDev(() => ErrorHandler.publicBody(data))).toBe(data.errorBody)
    expect(asDev(() => ErrorHandler.publicBody(data))).toContain(':1:27')
  })
})

/**
 * `import.meta.env.DEV` is a getter on `process.env` installed by `core/init`,
 * so it is swapped by descriptor and put back — not assigned to, which throws
 * once init has defined the getter, and not module-mocked, which never
 * unwinds.
 */
function asDev<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.env, 'DEV')
  Object.defineProperty(process.env, 'DEV', {
    get: () => true,
    configurable: true,
  })

  try {
    return fn()
  } finally {
    if (original) Object.defineProperty(process.env, 'DEV', original)
    else delete (process.env as any).DEV
  }
}

describe('ErrorHandler.publicBody', () => {
  const thrown = () => {
    const err = new Error('SQLiteError: no such table: ecr_student_entry')
    return ErrorHandler.extractErrorData(err)
  }

  test('a 5xx body never carries the stack off the process', () => {
    const data = thrown()
    // extractErrorData must keep it — that is what the server log prints.
    expect(data.errorBody).toContain('$error.test')
    expect(ErrorHandler.publicBody(data)).not.toContain('$error.test')
    expect(ErrorHandler.publicBody(data)).not.toContain('ecr_student_entry')
    expect(ErrorHandler.publicBody(data)).toBe('An unexpected error occurred.')
  })

  test('the stack is still returned in development', () => {
    const data = thrown()
    expect(asDev(() => ErrorHandler.publicBody(data))).toBe(data.errorBody)
  })

  test('a 4xx body is authored, not captured, and passes through', () => {
    const data = ErrorHandler.extractErrorData(
      new Response(null, { status: 404, statusText: 'Not Found' }),
    )
    expect(ErrorHandler.publicBody(data)).toBe(data.errorBody)
  })
})

describe('ErrorHandler.isError', () => {
  test('returns true for error responses', () => {
    expect(ErrorHandler.isError(new Response('err', { status: 500 }))).toBe(
      true,
    )
    expect(ErrorHandler.isError(new Response('ok', { status: 200 }))).toBe(
      false,
    )
  })

  test('returns true for HandlerError', () => {
    expect(ErrorHandler.isError(new HandlerError('test'))).toBe(true)
  })

  test('returns true for object with errorCode >= 400', () => {
    expect(ErrorHandler.isError({ errorCode: 404 })).toBe(true)
    expect(ErrorHandler.isError({ errorCode: 200 })).toBe(false)
  })

  test('returns false for plain strings and numbers', () => {
    expect(ErrorHandler.isError('error')).toBe(false)
    expect(ErrorHandler.isError(404)).toBe(false)
  })
})
