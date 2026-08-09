import { describe, expect, test } from 'bun:test'
import { deferredValue, hasDeferredValue, is, Math2, throws } from './misc'

describe('is', () => {
  test('is.string', () => {
    expect(is.string('hello')).toBe(true)
    expect(is.string(42)).toBe(false)
    expect(is.string(null)).toBe(false)
  })

  test('is.function', () => {
    expect(is.function(() => {})).toBe(true)
    expect(is.function(class {})).toBe(true)
    expect(is.function(42)).toBe(false)
  })

  test('is.object', () => {
    expect(is.object({ a: 1 })).toBe(true)
    expect(is.object([])).toBe(true)
    expect(is.object(null)).toBe(false)
    expect(is.object(42)).toBe(false)
  })

  test('is.number', () => {
    expect(is.number(42)).toBe(true)
    expect(is.number(0)).toBe(true)
    expect(is.number(NaN)).toBe(true)
    expect(is.number('42')).toBe(false)
  })

  test('is.boolean', () => {
    expect(is.boolean(true)).toBe(true)
    expect(is.boolean(false)).toBe(true)
    expect(is.boolean(1)).toBe(false)
  })

  test('is.array', () => {
    expect(is.array([])).toBe(true)
    expect(is.array([1, 2])).toBe(true)
    expect(is.array({})).toBe(false)
  })

  test('is.null', () => {
    expect(is.null(null)).toBe(true)
    expect(is.null(undefined)).toBe(false)
  })

  test('is.undefined', () => {
    expect(is.undefined(undefined)).toBe(true)
    expect(is.undefined(null)).toBe(false)
  })
})

describe('Math2', () => {
  test('clamp with min and max', () => {
    expect(Math2.clamp(5, 0, 10)).toBe(5)
    expect(Math2.clamp(-5, 0, 10)).toBe(0)
    expect(Math2.clamp(15, 0, 10)).toBe(10)
  })

  test('clamp with only min', () => {
    expect(Math2.clamp(-5, 0)).toBe(0)
    expect(Math2.clamp(5, 0)).toBe(5)
  })

  test('clamp with no bounds', () => {
    expect(Math2.clamp(42)).toBe(42)
  })

  test('step rounds to nearest step', () => {
    expect(Math2.step(7, 5)).toBe(5)
    expect(Math2.step(8, 5)).toBe(10)
    expect(Math2.step(2.3, 0.5)).toBe(2.5)
  })
})

describe('deferredValue', () => {
  test('lazily computes value on first access', () => {
    let callCount = 0
    const obj = { x: 10 }
    deferredValue(obj, 'doubled', (o: any) => {
      callCount++
      return o.x * 2
    })

    expect(callCount).toBe(0)
    expect((obj as any).doubled).toBe(20)
    expect(callCount).toBe(1)

    expect((obj as any).doubled).toBe(20)
    expect(callCount).toBe(1)
  })

  test('can be overridden via setter', () => {
    const obj = {}
    deferredValue(obj, 'lazy', () => 'computed')
    expect((obj as any).lazy).toBe('computed')
    ;(obj as any).lazy = 'overridden'
    expect((obj as any).lazy).toBe('overridden')
  })
})

describe('hasDeferredValue', () => {
  test('returns false when no deferred values exist', () => {
    expect(hasDeferredValue({}, 'key')).toBe(false)
  })

  test('returns true after deferredValue is set', () => {
    const obj = {}
    deferredValue(obj, 'd', () => 1)

    void (obj as any).d
    expect(hasDeferredValue(obj, 'd')).toBe(true)
  })

  test('returns false for unset key on object with deferred values', () => {
    const obj = {}
    deferredValue(obj, 'd', () => 1)
    void (obj as any).d
    expect(hasDeferredValue(obj, 'other')).toBe(false)
  })
})

describe('throws', () => {
  test('throws string as Error', () => {
    expect(() => throws('boom')).toThrow('boom')
  })

  test('throws Error directly', () => {
    const err = new Error('direct')
    expect(() => throws(err)).toThrow(err)
  })
})
