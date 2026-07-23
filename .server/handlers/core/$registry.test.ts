import { describe, test, expect } from 'bun:test'
import { HandlerMap } from './$registry'
import { Handler } from './$base'

class TestHandlerA extends Handler {
  static override canHandle(path: string) {
    return path.startsWith('/a')
  }
}

class TestHandlerB extends Handler {
  static override canHandle(path: string) {
    return path.startsWith('/b')
  }
}

describe('HandlerMap', () => {
  test('set and list handlers sorted by priority', () => {
    const map = new HandlerMap()
    map.set(TestHandlerA, 5)
    map.set(TestHandlerB, 10)

    const list = map.list()
    expect(list.length).toBe(2)
    expect(list[0]).toBe(TestHandlerB) // higher priority first
    expect(list[1]).toBe(TestHandlerA)
  })

  test('add is alias for set', () => {
    const map = new HandlerMap()
    map.add(TestHandlerA, 1)
    expect(map.list().length).toBe(1)
  })

  test('list is cached', () => {
    const map = new HandlerMap()
    map.set(TestHandlerA, 1)
    const list1 = map.list()
    const list2 = map.list()
    expect(list1).toBe(list2)
  })

  test('set invalidates cached list', () => {
    const map = new HandlerMap()
    map.set(TestHandlerA, 1)
    const list1 = map.list()
    map.set(TestHandlerB, 2)
    const list2 = map.list()
    expect(list1).not.toBe(list2)
    expect(list2.length).toBe(2)
  })

  test('resolve returns handler that canHandle', async () => {
    const map = new HandlerMap()
    map.set(TestHandlerA, 10)
    map.set(TestHandlerB, 10)

    const resolved = await map.resolve('/a/test')
    expect(resolved).toBe(TestHandlerA)

    const resolved2 = await map.resolve('/b/test')
    expect(resolved2).toBe(TestHandlerB)
  })

  test('resolve returns null when no handler matches', async () => {
    const map = new HandlerMap()
    map.set(TestHandlerA, 10)

    const resolved = await map.resolve('/c/test')
    expect(resolved).toBeNull()
  })

  test('empty HandlerMap has empty list', () => {
    const map = new HandlerMap()
    expect(map.list()).toEqual([])
  })
})
