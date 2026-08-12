import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RequestError, request } from './utils'

/**
 * `request()` used to throw a bare `Error` carrying only the envelope's
 * `message` on a non-2xx response, so the `data` half of the JSON envelope —
 * a 409's conflict list, a 400's per-field issues — was unreachable, and
 * callers dropped to raw `fetch` exactly where the envelope mattered most.
 *
 * `fetch` is swapped for a stub and restored, in the `withEnvFlag` spirit:
 * a global mutated for a test must be put back for the files after it.
 */
const realFetch = globalThis.fetch

function respondWith(body: unknown, httpStatus = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: httpStatus,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
}

beforeAll(() => {
  // Nothing here — each test installs its own stub — but the symmetric
  // afterAll below is the part that matters.
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe('request() keeps the error envelope', () => {
  test('a 2xx envelope resolves as before', async () => {
    respondWith({ time: 1, status: 200, message: 'OK', data: { id: 7 } })

    const res = await request('/api/orders/7')
    expect(res.data).toEqual({ id: 7 })
  })

  test('a 409 throws a RequestError that still carries data', async () => {
    const conflicts = [{ row: 3, reason: 'duplicate tracking number' }]
    respondWith({ time: 1, status: 409, message: 'Conflict', data: conflicts })

    try {
      await request('/api/orders', 'POST', { tracking: 'RA123' })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      const err = error as RequestError
      expect(err.message).toBe('Conflict')
      expect(err.status).toBe(409)
      expect(err.data).toEqual(conflicts)
    }
  })

  test('an envelope with no data still throws, with data undefined', async () => {
    respondWith({ time: 1, status: 404, message: 'Not Found' })

    try {
      await request('/api/orders/999')
      throw new Error('should have thrown')
    } catch (error) {
      const err = error as RequestError
      expect(err).toBeInstanceOf(RequestError)
      expect(err.status).toBe(404)
      expect(err.data).toBeUndefined()
    }
  })

  test('a non-JSON body throws with the HTTP status', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>gateway timeout</html>', {
        status: 504,
      })) as unknown as typeof fetch

    try {
      await request('/api/orders')
      throw new Error('should have thrown')
    } catch (error) {
      const err = error as RequestError
      expect(err).toBeInstanceOf(RequestError)
      expect(err.status).toBe(504)
    }
  })
})
