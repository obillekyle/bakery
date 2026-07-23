import { describe, test, expect } from 'bun:test'
import { JsonResponseData, jsonResponse } from './json'

describe('jsonResponse', () => {
  test('creates JsonResponseData instance', () => {
    const res = jsonResponse(200, 'OK', { id: 1 })
    expect(res).toBeInstanceOf(JsonResponseData)
    expect(res.status).toBe(200)
    expect(res.message).toBe('OK')
    expect(res.data).toEqual({ id: 1 })
    expect(res.time).toBe(0)
  })

  test('data is optional', () => {
    const res = jsonResponse(201, 'Created')
    expect(res.data).toBeUndefined()
  })
})

describe('JsonResponseData', () => {
  test('toJson() serializes correctly', () => {
    const res = jsonResponse(200, 'success', { name: 'test' })
    res.time = 123.45
    const json = res.toJson()
    const parsed = JSON.parse(json)

    expect(parsed).toEqual({
      time: 123.45,
      status: 200,
      message: 'success',
      data: { name: 'test' },
    })
  })

  test('toJson() handles undefined data', () => {
    const res = jsonResponse(404, 'Not Found')
    const parsed = JSON.parse(res.toJson())
    expect(parsed.data).toBeUndefined()
    expect(parsed.status).toBe(404)
  })
})
