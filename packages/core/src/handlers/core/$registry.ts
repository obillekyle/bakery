import { LRUCache } from '../../cache/lru'
import type { Handler } from './$base'

/**
 * Registry ids for `routeCache` keys. A module counter gives the same
 * per-process uniqueness a UUID did (the cache never outlives the process)
 * with a key prefix of a few characters instead of thirty-six.
 */
let nextMapId = 0

export class HandlerMap<T extends typeof Handler = typeof Handler> extends Map<
  any,
  number
> {
  public static routeCache = new LRUCache<string, typeof Handler>(
    import.meta.env.THREAD_WORKER ? 500 : 5000,
  )

  private cachedList: T[] | null = null
  private cachedGates: T[] | null = null
  private cachedOrder: Map<any, number> | null = null
  private id = nextMapId++

  constructor(entries?: readonly (readonly [any, number])[] | null) {
    super()
    if (!entries) return

    for (const [handlerClass, priority] of entries) {
      this.set(handlerClass, priority)
    }
  }

  set(handlerClass: any, priority: number = 10): this {
    super.set(handlerClass, priority)
    this.cachedList = null
    this.cachedGates = null
    this.cachedOrder = null
    return this
  }

  add(handlerClass: any, priority?: number): this {
    return this.set(handlerClass, priority)
  }

  list(): T[] {
    if (this.cachedList) {
      return this.cachedList
    }
    this.cachedList = Array.from(this.entries())
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0])

    return this.cachedList
  }

  /** Handlers that opt out of the cache bypass, in priority order. */
  private gatekeepers(): T[] {
    this.cachedGates ??= this.list().filter(h => (h as any).alwaysResolve)
    return this.cachedGates
  }

  /** Position of each handler in the priority-sorted list. */
  private order(): Map<any, number> {
    this.cachedOrder ??= new Map(this.list().map((h, i) => [h, i]))
    return this.cachedOrder
  }

  /**
   * `canHandle` without the microtask hop when the answer is synchronous.
   *
   * Most canHandles are plain predicates, and `await`ing their boolean cost a
   * microtask hop (~426ns) per probe, 2–4 probes per request. Returns a
   * boolean for a sync answer and the promise itself for an async one, so
   * callers only `await` a value that is actually a promise:
   *
   *     const r = HandlerMap.probe(...)
   *     if (r === true || (r !== false && (await r))) ...
   */
  private static probe(
    handler: any,
    path: string,
    req: Request | undefined,
    rest: any[],
  ): boolean | Promise<any> {
    const r = handler.canHandle(path, req, ...rest)
    return r && typeof (r as any).then === 'function' ? r : Boolean(r)
  }

  /**
   * The first extra argument is the request in every registry's call shape
   * (fetch: `(path, req)`, websocket: `(path, req)`, error:
   * `(path, req, error)`), so it is named rather than fished out of a variadic
   * list with an `instanceof` scan per request. `...rest` carries the error
   * registry's error through to `canHandle`/`handle` untouched.
   */
  async resolve(path: string, req?: Request, ...rest: any[]) {
    const host = req?.__hostname || ''
    const pathId = `${this.id}:${host}:${path}`
    const cached: any = HandlerMap.routeCache.get(pathId)

    // Only tracked once there is a cache hit to skip past. Middleware has
    // side effects (sessions, rate-limit counters), so a handler probed on the
    // cache path must not be probed a second time by the loop below.
    let probed: Set<any> | null = null

    if (cached) {
      probed = new Set()
      // A cache hit skips every handler above the cached one. Ask the
      // gatekeepers that outrank it first — the same handlers, in the same
      // order, a cold resolve would have reached before the cached one.
      const rank = this.order().get(cached) ?? Number.POSITIVE_INFINITY
      for (const gate of this.gatekeepers()) {
        if ((this.order().get(gate) ?? 0) >= rank) break
        probed.add(gate)
        const r = HandlerMap.probe(gate, path, req, rest)
        if (r === true || (r !== false && (await r))) return gate
      }

      probed.add(cached)
      const r = HandlerMap.probe(cached, path, req, rest)
      if (r === true || (r !== false && (await r))) return cached
      HandlerMap.routeCache.delete(pathId)
    }

    for (const handler of this.list() as any) {
      if (probed?.has(handler)) continue
      const r = HandlerMap.probe(handler, path, req, rest)
      if (r === true || (r !== false && (await r))) {
        // A gatekeeper's `true` describes this request, not this path. Caching
        // it would both evict the path's real handler and park a per-request
        // decision in a cache that has no TTL.
        if (!handler.alwaysResolve) HandlerMap.routeCache.set(pathId, handler)
        return handler as T
      }
    }

    return null
  }

  initRoutes() {
    return Promise.all(this.list().map(handler => handler.initRoutes()))
  }

  handle(path: string, req?: Request, ...rest: any[]): Handler.Response
  async handle(path: string, req?: Request, ...rest: any[]) {
    const handler: any = await this.resolve(path, req, ...rest)

    return handler ? handler.handle(path, req, ...rest) : null
  }
}
