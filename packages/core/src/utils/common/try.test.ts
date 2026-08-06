import { describe, test, expect } from 'bun:test'
import { Try } from './try'

describe('Try()', () => {
  test('returns value on success', () => {
    expect(Try(() => 42)).toBe(42)
  })

  test('returns null on sync error', () => {
    expect(Try(() => { throw new Error('boom') })).toBeNull()
  })

  test('returns null on async error', async () => {
    const result = await Try(Promise.reject(new Error('boom')))
    expect(result).toBeNull()
  })

  test('returns promise result', async () => {
    expect(await Try(Promise.resolve(10))).toBe(10)
  })
})

describe('Try.catch', () => {
  test('returns [null, value] on success (sync)', async () => {
    const result = await Try.catch(() => 42)
    expect(result).toEqual([null, 42])
  })

  test('returns [error, null] on sync error', async () => {
    const result: any = await Try.catch(() => { throw new Error('boom') })
    expect(result[0]).toBeInstanceOf(Error)
    expect(result[0].message).toBe('boom')
    expect(result[1]).toBeNull()
  })

  test('returns [null, value] on success (async)', async () => {
    const result: any = await Try.catch(async () => 42)
    expect(result[0]).toBeNull()
    expect(result[1]).toBe(42)
  })

  test('returns [error, null] on async rejection', async () => {
    const result: any = await Try.catch(Promise.reject(new Error('async boom')))
    expect(result[0]).toBeInstanceOf(Error)
    expect(result[0].message).toBe('async boom')
    expect(result[1]).toBeNull()
  })

  test('handles plain value (non-function, non-promise)', async () => {
    const result: any = await Try.catch(42)
    expect(result[0]).toBeNull()
    expect(result[1]).toBe(42)
  })
})

describe('Try.return', () => {
  test('returns value on success', () => {
    expect(Try.return(() => 42, 0)).toBe(42)
  })

  test('returns default on sync error', () => {
    expect(Try.return(() => { throw new Error('boom') }, 0)).toBe(0)
  })

  test('calls default function with error', () => {
    const result = Try.return(
      () => { throw new Error('boom') },
      (err: Error) => err.message.length,
    )
    expect(result).toBe(4)
  })

  test('handles async rejection with default value', async () => {
    const result = await Try.return(Promise.reject('fail'), 'fallback')
    expect(result).toBe('fallback')
  })

  test('handles async rejection with default function', async () => {
    const result = await Try.return(
      Promise.reject(new Error('async')),
      (err: any) => `caught:${err.message}`,
    )
    expect(result).toBe('caught:async')
  })

  test('passes through promise success', async () => {
    const result = await Try.return(Promise.resolve(10), 0)
    expect(result).toBe(10)
  })
})

describe('Try.throw', () => {
  test('rethrows with custom string message', () => {
    expect(() => Try.throw(() => { throw new Error('original') }, 'custom'))
      .toThrow('custom')
  })

  test('rethrows with custom Error', () => {
    const custom = new Error('custom')
    expect(() => Try.throw(() => { throw new Error('original') }, custom))
      .toThrow(custom)
  })

  test('rethrows original when no override', () => {
    expect(() => Try.throw(() => { throw new Error('original') }))
      .toThrow('original')
  })

  test('works with async callback', async () => {
    try {
      await Try.throw(async () => { throw new Error('async') }, 'wrapped')
      expect.unreachable()
    } catch (e: any) {
      expect(e.message).toBe('wrapped')
    }
  })
})
