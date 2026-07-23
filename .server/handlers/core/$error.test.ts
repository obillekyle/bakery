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
