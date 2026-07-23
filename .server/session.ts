import { Bakery } from '@server/core/bakery'
import { hasDeferredValue } from '@server/utils'
import { TieredCache } from './cache/tiered'
import { DEFAULT_SESSION_PERSIST, DEFAULT_SESSION_TTL } from './utils/constants'

export class Session<
  T extends MapOf<any> = MapOf<any>,
  TK extends keyof T | (string & {}) = keyof T | (string & {}),
> {
  public static cache = new TieredCache<string, Session<any>>('sessions', {
    memoryThreshold: 1000,
    flushInterval: 30000,
    reviver: (json: any) =>
      Session.reconstruct({
        id: json.id,
        createdAt: json.createdAt,
        persistKeys: json.persistKeys,
        data: json.data,
      }),
    shouldPersist: session => session.hasPersistedKeys() || session.hasData(),
  })

  public static get count() {
    return Session.cache.count
  }

  public static bind(req: Request, response?: Response) {
    if (!response) return response

    const cookieValue = Session.getCookie(req)
    if (cookieValue) response.headers.append('Set-Cookie', cookieValue)

    return response
  }

  public static getCookie(req: Request): string {
    if (!hasDeferredValue(req, 'session')) return ''
    if (!req.session.modified) return ''

    Session.cache.set(req.session.id, req.session)
    req.session.modified = false

    const time = DEFAULT_SESSION_PERSIST / 1000
    const session = req.session
    const hasPersistedKeys = session.persistedKeys.length > 0

    const secureFlag = import.meta.env.DEV ? '' : '; Secure'
    return hasPersistedKeys
      ? `sId=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${time}${secureFlag}`
      : `sId=${session.id}; Path=/; HttpOnly; SameSite=Lax${secureFlag}`
  }

  public static delete(reqOrId: string | Request): boolean {
    const id = this.getSessionId(reqOrId)
    return id ? Session.cache.delete(id) : false
  }

  public static create<T extends MapOf<any>>(metadata: {
    id: string
    persistKeys: string[] | Set<string>
    data: Partial<T>
  }): Session<T> {
    const session = Session.reconstruct<T>(metadata)
    Session.cache.set(session.id, session)
    return session
  }

  public static reconstruct<T extends MapOf<any>>(metadata: {
    id: string
    createdAt?: number
    persistKeys: string[] | Set<string>
    data: Partial<T>
  }): Session<T> {
    const session = new Session<T>(metadata.id, metadata.createdAt)
    session.persistKeys = new Set(metadata.persistKeys)
    session.rawData = { ...metadata.data }
    session.data = session.initProxy()
    return session
  }

  private static getSessionId(request: Request | string): string {
    if (typeof request === 'string') return request || Bun.randomUUIDv7()
    const rawReq = request as any
    if (rawReq._session) return rawReq._session.id

    if (!request.headers.has('cookie')) return ''
    const cookieHeader = request.headers.get('cookie') || ''
    return cookieHeader.match(/(?:^|;\s*)sId=([^;]+)/)?.[1] || ''
  }

  public static from<T extends MapOf<any> = MapOf<any>>(
    request: Request,
  ): Session<T> {
    const rawReq = request as any
    if (rawReq._session) return rawReq._session as any
    const sessionId = Session.getSessionId(request)

    if (sessionId) {
      const existing = Session.cache.get(sessionId)
      if (existing) {
        return existing
      }
    }

    return new Session()
  }

  public readonly id!: string
  public readonly createdAt!: number

  protected modified: boolean = false
  protected persistKeys!: Set<string>

  protected rawData: Partial<T> = {}
  public data!: Partial<T>

  constructor(sessid?: string, createdAt?: number) {
    sessid = sessid || Bun.randomUUIDv7()

    this.id = sessid
    this.createdAt = createdAt || Date.now()
    this.persistKeys = new Set()
    this.rawData = {}
    this.data = this.initProxy()
  }

  private initProxy(): Partial<T> {
    return new Proxy(this.rawData, {
      get: (target, prop: string) => target[prop as keyof T],
      set: (target, prop: string, value) => {
        target[prop as keyof T] = value
        this.modified = true
        return true
      },
      deleteProperty: (target, prop: string) => {
        delete target[prop as keyof T]
        this.modified = true
        return true
      },
    })
  }

  public get isModified() {
    return this.modified
  }
  public get accessedAt() {
    return Session.cache.getAccessedAt(this.id) ?? Date.now()
  }
  public get persistedKeys() {
    return Array.from(this.persistKeys)
  }

  public hasPersistedKeys() {
    return this.persistKeys.size > 0
  }

  public hasData() {
    return Object.keys(this.rawData).length > 0
  }

  public isExpired(): boolean {
    const accessed = this.accessedAt
    return this.hasPersistedKeys()
      ? Date.now() - accessed > DEFAULT_SESSION_PERSIST
      : Date.now() - accessed > DEFAULT_SESSION_TTL
  }

  public persist(key: keyof T | (string & {}), state: boolean = true): this {
    this.persistKeys[state ? 'add' : 'delete'](key as string)
    this.modified = true

    if (this.persistKeys.size > 0) {
      Session.cache.set(this.id, this)
    }

    return this
  }

  public reset(full = false): void {
    if (full) this.persistKeys.clear()

    for (const key of Object.keys(this.rawData)) {
      if (this.persistKeys.has(key)) continue
      delete this.rawData[key as keyof T]
    }

    if (!this.hasPersistedKeys()) {
      Session.cache.delete(this.id)
      this.modified = false
    } else {
      Session.cache.set(this.id, this)
    }
  }

  get<K extends keyof T>(key: K): T[K] | undefined
  get<K extends keyof T>(key: K, defaultValue: T[K]): T[K]
  get<R = string>(key: string & {}): R | undefined
  get(key: string & {}, defaultValue: boolean): boolean
  get(key: string & {}, defaultValue: number): number
  get(key: string & {}, defaultValue: string): string
  get<R = string>(key: string & {}, defaultValue: R): R
  public get(key: any, defaultValue?: any): any {
    return (this.rawData[key] ?? defaultValue) as any
  }

  set<K extends keyof T>(key: K, value: T[K], persist?: boolean): this
  set<V = any>(key: string & {}, value: V, persist?: boolean): this
  public set(key: any, value: any, persist = false): this {
    ;(this.data as any)[key] = value
    if (persist) this.persist(key, true)
    return this
  }

  public delete(key: TK, persist?: boolean): this {
    if (!key) return this

    if (persist) this.persist(key, false)
    delete this.data[key]
    return this
  }

  public bind(response?: Response) {
    return Session.bind({ session: this } as any, response)
  }

  public destroy(): void {
    Session.delete(this.id)
  }

  public toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      accessedAt: this.accessedAt,
      persistKeys: Array.from(this.persistKeys),
      data: { ...this.rawData },
    }
  }

  static async *[Symbol.asyncIterator]() {
    for await (const sess of Session.cache.values()) {
      yield sess
    }
  }

  static async get(sessid: string): Promise<Session<any> | undefined> {
    return await Session.cache.get(sessid)
  }

  static entries() {
    return Session.cache.entries()
  }

  static values() {
    return Session.cache.values()
  }

  static keys() {
    return Session.cache.keys()
  }

  static list(options: {
    search?: string
    page: number
    pageSize: number
    sortBy: string
    sortOrder: 'ASC' | 'DESC'
  }) {
    return Session.cache.search(options)
  }
}

const sessionPruneTimer = setInterval(
  function cleanUpSessions() {
    Session.cache.prune(DEFAULT_SESSION_TTL, '$.persistKeys')
    Session.cache.prune(DEFAULT_SESSION_PERSIST)
  },
  1000 * 60 * 15, // prune every 15 minutes
)

Bakery.onShutdown(() => {
  clearInterval(sessionPruneTimer)
})
