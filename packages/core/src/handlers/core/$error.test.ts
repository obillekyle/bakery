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
    const res = new Response('Not Found', { status: 404, statusText: 'Not Found' })
    const data = ErrorHandler.extractErrorData(res)
    expect(data.errorCode).toBe(404)
    expect(data.errorText).toBe('Not Found')
  })

  test('extracts from object with errorCode', () => {
    const data = ErrorHandler.extractErrorData({ errorCode: 403, errorText: 'Forbidden', errorBody: 'denied' })
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
    expect(ErrorHandler.isError(new Response('err', { status: 500 }))).toBe(true)
    expect(ErrorHandler.isError(new Response('ok', { status: 200 }))).toBe(false)
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
