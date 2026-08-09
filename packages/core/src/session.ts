import { TieredCache } from './cache/tiered'
import { Bakery, hostKey } from './core/bakery'
import type { MapOf } from './types'
import { hasDeferredValue } from './utils'
import { DEFAULT_SESSION_PERSIST, DEFAULT_SESSION_TTL } from './utils/constants'

/**
 * Keys under this prefix are framework-internal privilege markers. They share
 * the same bag as application data, so anything that writes a caller-supplied
 * key must refuse this prefix — otherwise a preferences endpoint (or the
 * dashboard's own session editor) becomes a privilege-escalation primitive.
 */
export const RESERVED_SESSION_PREFIX = '__bakery.'

/** Marks a session as having passed the DASHPASS check. */
export const DASHPASS_SESSION_KEY = `${RESERVED_SESSION_PREFIX}dashpass`

export function isReservedSessionKey(key: string): boolean {
  return key.startsWith(RESERVED_SESSION_PREFIX)
}

/**
 * Clock seam — the cookie half-life bookkeeping is time-based, and its tests
 * inject a clock instead of sleeping (see `__setTestDb` / `__setTestConfig`
 * for the pattern). Only the cookie-reissue math reads this; `createdAt` and
 * TTL expiry keep `Date.now()`.
 */
let clock: () => number = Date.now

export function __setTestClock(fn: () => number): void {
  clock = fn
}

export function __resetTestClock(): void {
  clock = Date.now
}

/**
 * The session id is the sole bearer token, so it must be unguessable. UUIDv7
 * carries a monotonic millisecond timestamp and only ~74 random bits, which
 * makes ids issued at a known time partially predictable.
 */
export function newSessionId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    'base64url',
  )
}

/**
 * The cache key for a session id under the current host.
 *
 * There is one `TieredCache('sessions')` for the whole process, and until this
 * existed every id went into it unqualified — so under a multi-tenant `hosts`
 * config one tenant's dashboard listed, read and deleted every other tenant's
 * sessions. `hostKey()` is the guard the five other per-tenant caches already
 * use; sessions were the one that never got it.
 *
 * An unconfigured host resolves to the empty prefix (see `hostKey`), which is
 * also the single-host case, so a single-host app's keys are unchanged.
 */
function sessionKey(id: string): string {
  return hostKey(id)
}

/** `'host:'` under a configured host, `''` otherwise. */
function sessionScope(): string {
  return hostKey('')
}

/**
 * Whether a raw cache key belongs to `scope`.
 *
 * `startsWith` alone is not enough for the default scope, where every key would
 * match. Session ids are base64url and can never contain `:`, so what follows
 * the prefix identifies the bucket unambiguously.
 */
function inScope(key: string, scope: string): boolean {
  return key.startsWith(scope) && !key.slice(scope.length).includes(':')
}

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
        cookieIssuedAt: json.cookieIssuedAt,
      }),
    shouldPersist: session => session.hasPersistedKeys() || session.hasData(),
  })

  /**
   * Process-wide session count, deliberately not host-scoped: it is a capacity
   * metric (analytics samples it on a timer), not tenant data, and scoping it
   * would mean walking every key on every sample.
   */
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
    const session = req.session

    // Issue only when the session actually changed, or when the read path
    // flagged a half-life refresh (see `markAccessed`) — not on every read.
    // A per-request Set-Cookie made every session-carrying response unique,
    // defeating If-None-Match, and dirtied merely-read sessions into the
    // flush timer's write batch.
    if (!session.modified && !session.cookieRefreshDue) return ''

    // Storing here serves both cases: a modified session must persist, and a
    // half-life refresh must renew the row's accessedAt so the pruner's
    // server-side TTL slides with the cookie (and `cookieIssuedAt` rides
    // along in the same write).
    Session.cache.set(sessionKey(session.id), session)
    session.modified = false
    session.cookieRefreshDue = false
    session.cookieIssuedAt = clock()

    // `persistedKeys` allocates an Array off the Set purely to read `.length`;
    // `hasPersistedKeys()` reads `Set.size` and answers the same question.
    const hasPersistedKeys = session.hasPersistedKeys()
    const maxAgeSeconds = hasPersistedKeys
      ? Math.floor(DEFAULT_SESSION_PERSIST / 1000)
      : Math.floor(DEFAULT_SESSION_TTL / 1000)

    // Only believe x-forwarded-proto behind a trusted proxy — the same rule
    // getHostname and getClientIp already apply. In production default to
    // Secure, so a terminator that omits the header can't downgrade the cookie.
    const trustProxy = Bakery.config.trustProxy
    const forwardedHttps =
      trustProxy && req.headers.get('x-forwarded-proto') === 'https'
    const isHttps = Boolean(
      (req.url && req.url.startsWith('https:')) ||
        forwardedHttps ||
        import.meta.env.PROD,
    )
    const secureFlag = isHttps ? '; Secure' : ''
    return `sId=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`
  }

  public static delete(reqOrId: string | Request): boolean {
    const id = this.getSessionId(reqOrId)
    return id ? Session.cache.delete(sessionKey(id)) : false
  }

  public static create<T extends MapOf<any>>(metadata: {
    id: string
    persistKeys: string[] | Set<string>
    data: Partial<T>
  }): Session<T> {
    const session = Session.reconstruct<T>(metadata)
    Session.cache.set(sessionKey(session.id), session)
    return session
  }

  public static reconstruct<T extends MapOf<any>>(metadata: {
    id: string
    createdAt?: number
    persistKeys: string[] | Set<string>
    data: Partial<T>
    cookieIssuedAt?: number
  }): Session<T> {
    const session = new Session<T>(metadata.id, metadata.createdAt)
    session.persistKeys = new Set(metadata.persistKeys)
    session.rawData = { ...metadata.data }
    session.data = session.initProxy()
    // Rows written before the field existed revive as 0 = "unknown", which
    // `markAccessed` reads as long past half-life — at worst one extra
    // reissue, never a cookie that silently expires under an active user.
    session.cookieIssuedAt = metadata.cookieIssuedAt ?? 0
    return session
  }

  private static getSessionId(request: Request | string): string {
    if (typeof request === 'string') return request || newSessionId()
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
      const existing = Session.cache.get(sessionKey(sessionId))
      if (existing) {
        // Enforce the TTL on read. Previously expiry relied solely on the
        // 15-minute prune interval, so a stolen id stayed usable past its TTL.
        if (existing.isExpired()) {
          Session.cache.delete(sessionKey(sessionId))
        } else {
          // Accessed, not modified — see `markAccessed`. `touch()` here made
          // every session read count as a write.
          existing.markAccessed()
          return existing
        }
      }
    }

    return new Session()
  }

  public readonly id!: string
  public readonly createdAt!: number

  protected modified: boolean = false

  /**
   * Epoch ms when `getCookie` last emitted `Set-Cookie` for this id; 0 means
   * never (or unknown — a row written before the field existed). Persisted
   * through `toJSON`, so it only costs a write when a write is already
   * happening; while the instance lives in the memory tier it carries across
   * requests for free.
   */
  protected cookieIssuedAt: number = 0

  /**
   * Set by `markAccessed` when the cookie has crossed half its Max-Age;
   * cleared when `getCookie` issues. Deliberately not persisted — it is
   * per-instance request bookkeeping, and losing it costs nothing (the next
   * read recomputes it from `cookieIssuedAt`).
   */
  protected cookieRefreshDue: boolean = false

  protected persistKeys!: Set<string>

  protected rawData: Partial<T> = {}
  public data!: Partial<T>

  constructor(sessid?: string, createdAt?: number) {
    sessid = sessid || newSessionId()

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

  /**
   * Force the session to count as modified: stored on the next flush and its
   * cookie re-issued. This is the published "force a cookie refresh" surface
   * (docs/guides/sessions.md) and keeps its dirty semantics. It is *not* the
   * read path — `Session.from` uses `markAccessed`, which slides expiry
   * without paying write costs.
   */
  public touch(): this {
    this.modified = true
    return this
  }

  /**
   * The read-path bump — what `Session.from` does instead of `touch()`.
   * Reading a session must not dirty it: that made every read-only request
   * pay a JSON.stringify + synchronous SQLite write on the next flush and
   * re-issue Set-Cookie, which defeated If-None-Match caching.
   *
   * Liveness needs no work here: the `Session.cache.get` in `from` has
   * already re-stamped the memory tier's accessedAt. What this method owns is
   * sliding cookie expiration — once more than half the cookie's Max-Age has
   * elapsed since it was last issued, flag a reissue. `getCookie` then emits
   * the cookie *and* re-persists the session, which renews the DB row's
   * accessedAt at a cadence of at most maxAge/2 against the pruner's cutoff
   * of maxAge — so active sessions never age out server-side either.
   */
  private markAccessed(): void {
    const maxAgeMs = this.hasPersistedKeys()
      ? DEFAULT_SESSION_PERSIST
      : DEFAULT_SESSION_TTL
    if (clock() - this.cookieIssuedAt > maxAgeMs / 2) {
      this.cookieRefreshDue = true
    }
  }

  public get isModified() {
    return this.modified
  }
  public get accessedAt() {
    return Session.cache.getAccessedAt(sessionKey(this.id)) ?? Date.now()
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
      Session.cache.set(sessionKey(this.id), this)
    }

    return this
  }

  /**
   * Mint a new session id, carrying the data and persisted keys across, and
   * drop the entry under the old one.
   *
   * This is the missing anti-fixation primitive. `reset()` clears data but
   * keeps the id, so an app that does `req.session.set('userId', …)` on login
   * finishes authentication on the *same* id the visitor arrived with —
   * including one an attacker planted. Call it at the privilege boundary:
   *
   * ```ts no-check — illustrative call site, not a compiled example
   * req.session.regenerate().set('userId', user.id, true)
   * ```
   *
   * Marking the session modified is what re-issues the cookie: `getCookie`
   * emits `sId=` from the current id and only when `modified` is set, and it is
   * the same object `req.session` already holds, so the rest of the request
   * sees the new id.
   *
   * `createdAt` is deliberately preserved — the session continues, only its
   * bearer token is replaced.
   */
  public regenerate(): this {
    const previous = this.id
    // `id` is readonly to callers; rotating it is the one legitimate write.
    ;(this as { id: string }).id = newSessionId()

    Session.cache.delete(sessionKey(previous))
    Session.cache.set(sessionKey(this.id), this)
    this.modified = true

    return this
  }

  public reset(full = false): void {
    if (full) this.persistKeys.clear()

    for (const key of Object.keys(this.rawData)) {
      if (this.persistKeys.has(key)) continue
      delete this.rawData[key as keyof T]
    }

    if (!this.hasPersistedKeys()) {
      Session.cache.delete(sessionKey(this.id))
      this.modified = false
      // A pending half-life refresh would make `getCookie` re-store the
      // session this branch just deleted.
      this.cookieRefreshDue = false
    } else {
      Session.cache.set(sessionKey(this.id), this)
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
      cookieIssuedAt: this.cookieIssuedAt,
      persistKeys: Array.from(this.persistKeys),
      data: { ...this.rawData },
    }
  }

  static async *[Symbol.asyncIterator]() {
    for (const [, sess] of Session.entries()) {
      yield sess
    }
  }

  static async get(sessid: string): Promise<Session<any> | undefined> {
    return await Session.cache.get(sessionKey(sessid))
  }

  /**
   * Every enumeration below filters to the current host and yields the bare
   * session id, not the cache key — so `Session.keys()` still returns ids the
   * dashboard can hand back to `Session.get` / `Session.delete`.
   */
  static *entries(): IterableIterator<[string, Session<any>]> {
    const scope = sessionScope()
    for (const [key, sess] of Session.cache.entries()) {
      if (!inScope(key, scope)) continue
      yield [key.slice(scope.length), sess]
    }
  }

  static *values(): IterableIterator<Session<any>> {
    for (const [, sess] of Session.entries()) yield sess
  }

  static *keys(): IterableIterator<string> {
    for (const [id] of Session.entries()) yield id
  }

  static list(options: {
    search?: string
    page: number
    pageSize: number
    sortBy: string
    sortOrder: 'ASC' | 'DESC'
  }) {
    // Fast path: with no `hosts` configured every key is already in the default
    // bucket, so the cache's own SQL paging is correctly scoped and there is no
    // reason to give it up.
    //
    // The check is on `hosts` and not on the scope, deliberately: `hostKey`
    // collapses to '' in the unconfigured case too, so the scope alone cannot
    // tell the two situations apart. This method used to compute one anyway and
    // never read it — scoping lives in `Session.entries()`, which the slow path
    // below goes through.
    const hosts = Bakery.config.hosts
    if (!hosts || Object.keys(hosts).length === 0) {
      return Session.cache.search(options)
    }

    // Scoped path: `TieredCache.search` pages in SQL across the whole table,
    // which is every tenant's sessions, and it has no key-prefix predicate — so
    // the filter has to happen before paging, in JS. Bounded by the session
    // table, which the pruner holds down to live sessions.
    const needle = options.search?.trim().toLowerCase() || ''
    const matched: Session<any>[] = []
    for (const [id, sess] of Session.entries()) {
      if (
        needle &&
        !id.toLowerCase().includes(needle) &&
        !JSON.stringify(sess).toLowerCase().includes(needle)
      ) {
        continue
      }
      matched.push(sess)
    }

    const dir = options.sortOrder === 'ASC' ? 1 : -1
    const rank = (s: Session<any>) =>
      options.sortBy === 'id'
        ? s.id
        : options.sortBy === 'keys'
          ? s.persistedKeys.length
          : s.accessedAt
    matched.sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)]
      if (ra < rb) return -dir
      if (ra > rb) return dir
      return a.id < b.id ? -dir : a.id > b.id ? dir : 0
    })

    const totalRows = matched.length
    const totalPages = Math.max(1, Math.ceil(totalRows / options.pageSize))
    const page = Math.min(options.page, totalPages)
    const offset = Math.max(0, (page - 1) * options.pageSize)

    return {
      rows: matched.slice(offset, offset + options.pageSize),
      totalRows,
      page,
      pageSize: options.pageSize,
      totalPages,
    }
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
