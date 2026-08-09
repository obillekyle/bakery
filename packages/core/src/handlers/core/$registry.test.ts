import { describe, expect, test } from 'bun:test'
import { Handler } from './$base'
import { HandlerMap } from './$registry'

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

/**
 * `resolve` only awaits a `canHandle` that actually returned a promise — the
 * sync fast path. These pin the two branches and the argument flow the error
 * registry depends on.
 */
describe('HandlerMap probe fast path', () => {
  test('an async canHandle is still awaited', async () => {
    class AsyncHandler extends Handler {
      static override async canHandle(path: string) {
        await Promise.resolve()
        return path.startsWith('/async')
      }
    }

    const map = new HandlerMap()
    map.set(AsyncHandler, 10)
    expect(await map.resolve('/async/x')).toBe(AsyncHandler)
    expect(await map.resolve('/other')).toBeNull()
  })

  test('arguments after the request reach canHandle (error-registry shape)', async () => {
    let seen: any[] = []
    class ErrShapeHandler extends Handler {
      static override canHandle(_path: string, req: Request, error?: any) {
        seen = [req, error]
        return Boolean(error)
      }
    }

    const map = new HandlerMap<any>()
    map.set(ErrShapeHandler, 10)
    const req = new Request('http://localhost/boom')
    const error = { errorCode: 500 }
    expect(await map.resolve('/boom', req, error)).toBe(ErrShapeHandler)
    expect(seen[0]).toBe(req)
    expect(seen[1]).toBe(error)
  })
})

/**
 * A stand-in for MiddlewareHandler, with the property that matters: `canHandle`
 * answers a question about *this request* ("was it denied"), not about the path.
 */
class GateHandler extends Handler {
  static override alwaysResolve = true
  static denied = new Set<string>()
  static probes = 0

  static override canHandle(_path: string, req: Request) {
    GateHandler.probes++
    const user = new URL(req.url).searchParams.get('user') || ''
    return GateHandler.denied.has(user)
  }
}

/** A page handler: its answer really is a property of the path. */
class PageHandler extends Handler {
  static override canHandle(path: string) {
    return path.startsWith('/secret')
  }
}

function asUser(user: string) {
  return new Request(`http://localhost/secret?user=${user}`)
}

describe('HandlerMap route cache', () => {
  function gatedMap() {
    GateHandler.denied = new Set(['mallory'])
    GateHandler.probes = 0
    const map = new HandlerMap()
    map.set(GateHandler, 100)
    map.set(PageHandler, 60)
    return map
  }

  test('a cache hit cannot bypass an alwaysResolve handler', async () => {
    const map = gatedMap()

    // Alice is allowed, so the gate declines and the page handler is cached.
    expect(await map.resolve('/secret', asUser('alice'))).toBe(PageHandler)

    // Mallory is denied. Before the fix the cached PageHandler answered first
    // and was returned, so one successful sign-in opened the path for everyone
    // until the (TTL-less) LRU entry was evicted.
    expect(await map.resolve('/secret', asUser('mallory'))).toBe(GateHandler)
  })

  test("a denial does not evict the path's real handler", async () => {
    const map = gatedMap()

    expect(await map.resolve('/secret', asUser('alice'))).toBe(PageHandler)
    expect(await map.resolve('/secret', asUser('mallory'))).toBe(GateHandler)
    expect(await map.resolve('/secret', asUser('bob'))).toBe(PageHandler)
  })

  test('a denied request first does not poison the path', async () => {
    // The gate answers before anything is cached, so nothing is written; the
    // next allowed request must still find the page handler.
    const map = gatedMap()

    expect(await map.resolve('/secret', asUser('mallory'))).toBe(GateHandler)
    expect(await map.resolve('/secret', asUser('alice'))).toBe(PageHandler)
    expect(await map.resolve('/secret', asUser('mallory'))).toBe(GateHandler)
  })

  test('the gate is probed exactly once per resolve', async () => {
    const map = gatedMap()

    await map.resolve('/secret', asUser('alice'))
    expect(GateHandler.probes).toBe(1)

    // On a cache hit the gate is consulted before the cached handler; it must
    // not then be consulted a second time by the probe chain. Middleware has
    // side effects (sessions, rate-limit counters), so twice is a bug.
    await map.resolve('/secret', asUser('alice'))
    expect(GateHandler.probes).toBe(2)
  })

  test('the cache still skips the handlers above the cached one', async () => {
    // The point of the cache is not probing the whole chain. A handler that
    // does not opt in must still be skipped on a hit, or the fix has quietly
    // turned the cache into a no-op.
    let probes = 0
    class NeverMatchesHandler extends Handler {
      static override canHandle() {
        probes++
        return false
      }
    }

    const map = new HandlerMap()
    map.set(NeverMatchesHandler, 90)
    map.set(PageHandler, 60)

    expect(await map.resolve('/secret', asUser('alice'))).toBe(PageHandler)
    expect(probes).toBe(1)

    expect(await map.resolve('/secret', asUser('alice'))).toBe(PageHandler)
    expect(probes).toBe(1)
  })
})
