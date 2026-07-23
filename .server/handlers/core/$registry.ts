import { LRUCache } from '@server/cache/lru'
import type { Handler } from './$base'

export class HandlerMap<T extends typeof Handler = typeof Handler> extends Map<
  any,
  number
> {
  public static routeCache = new LRUCache<string, typeof Handler>(
    import.meta.env.THREAD_WORKER ? 500 : 5000,
  )

  private cachedList: T[] | null = null
  private id = Bun.randomUUIDv7()

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

  async resolve(path: string, ...params: any[]) {
    const req = params.find((p: any) => p instanceof Request)
    const host = req?.__hostname || ''
    const pathId = `${this.id}:${host}:${path}`
    const cached: any = HandlerMap.routeCache.get(pathId)

    if (cached) {
      if (await cached.canHandle(path, ...params)) return cached
      HandlerMap.routeCache.delete(pathId)
    }

    for (const handler of this.list() as any) {
      if (handler === cached) continue
      if (await handler.canHandle(path, ...params)) {
        HandlerMap.routeCache.set(pathId, handler)
        return handler as T
      }
    }

    return null
  }

  initRoutes() {
    return Promise.all(this.list().map(handler => handler.initRoutes()))
  }

  handle(path: string, ...params: any[]): Handler.Response
  async handle(path: string, ...params: any[]) {
    const handler: any = await this.resolve(path, ...params)

    return handler ? handler.handle(path, ...params) : null
  }
}
