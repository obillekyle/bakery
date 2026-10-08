import { TieredCache } from './cache/tiered'
import { Bakery, hostKey } from './core/bakery'
import { peekConfig, resolveHostname } from './core/config'
import { hostStore } from './core/context'
import { errorMsg, serveLog } from './logger/serve-log'
import { signSessionId, verifiedSessionId } from './session-signing'
import type { MapOf } from './types'
import { deferredValue, hasDeferredValue } from './utils'
import { DEFAULT_SESSION_PERSIST, DEFAULT_SESSION_TTL } from './utils/constants'

/**
 * Keys under this prefix are framework-internal privilege markers. They share
 * the same bag as application data, so anything that writes a caller-supplied
 * key must refuse this prefix: otherwise a preferences endpoint (or the
 * dashboard's own session editor) becomes a privilege-escalation primitive.
 */
export const RESERVED_SESSION_PREFIX = '__bakery.'

export function isReservedSessionKey(key: string): boolean {
  return key.startsWith(RESERVED_SESSION_PREFIX)
}

/**
 * Clock seam: the cookie half-life bookkeeping is time-based, and its tests
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
 * existed every id went into it unqualified, so under a multi-tenant `hosts`
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

/** A session as a {@link SessionStore} keeps it. Times are epoch milliseconds. */
export interface StoredSession {
  id: string
  /** The configured host it belongs to, `''` for the default namespace. */
  host: string
  /**
   * The account it belongs to, as text: the value under the key that
   * `sessions.account` names, or null when there is none.
   */
  account: string | null
  createdAt: number
  /** When it was last written, which is when its cookie was last issued. */
  accessedAt: number
  /** When a store may forget it: `accessedAt` plus its idle timeout. */
  expiresAt: number
  persistKeys: string[]
  data: Record<string, unknown>
}

export interface SessionListOptions {
  search?: string
  page: number
  pageSize: number
  sortBy: string
  sortOrder: 'ASC' | 'DESC'
}

export interface SessionPage {
  rows: Session<any>[]
  totalRows: number
  page: number
  pageSize: number
  totalPages: number
}

/**
 * Where sessions live when `sessions.store` replaces the built-in store,
 * which is memory with `bakery/sessions.db` behind it.
 *
 * Every method is a round trip, and nothing here keeps a session between
 * requests. That is the point: with the built-in store each `--threads`
 * worker serves sessions from its own memory, so a session ended in one
 * worker lived on in another. A store every worker asks, and nobody caches,
 * ends it for the next request in all of them.
 * `@bakery-framework/orm/sessions` implements it over the app's database.
 */
export interface SessionStore {
  /** The session under this id and host, if it is still live at `now`. */
  load(
    host: string,
    id: string,
    now: number,
  ): Promise<StoredSession | undefined>
  /** Store a session that has never been stored. */
  insert(session: StoredSession): Promise<void>
  /**
   * Rewrite the session stored as `storedId`, which is its own id or the one
   * it had before `regenerate()`. False when nothing is stored under that id
   * any more, because something ended it after this request read it; then
   * nothing is written, since an update must never bring a session back.
   */
  update(storedId: string, session: StoredSession): Promise<boolean>
  /** Renew a stored session's times without rewriting it. False as for `update`. */
  touch(
    host: string,
    id: string,
    accessedAt: number,
    expiresAt: number,
  ): Promise<boolean>
  /** True when a session was removed. */
  remove(host: string, id: string): Promise<boolean>
  /** Remove every session of one account under one host: how many went. */
  removeAccount(host: string, account: string): Promise<number>
  /** Live sessions across every host. */
  count(now: number): Promise<number>
  /**
   * One page of the host's live sessions, and how many it has in all. A page
   * past the end is the last page.
   */
  list(
    host: string,
    options: SessionListOptions,
    now: number,
  ): Promise<{ rows: StoredSession[]; totalRows: number }>
  /** Forget what has expired by `now`: how many went. */
  prune(now: number): Promise<number>
}

/** `sessions` in `server.config.ts`. */
export interface SessionOptions {
  /** Where sessions live. Omitted, the built-in store. */
  store?: SessionStore
  /**
   * The session key that holds the account id. A store indexes it, so
   * `Session.endForAccount` can end every session of one account.
   */
  account?: string
  /**
   * Signs the session cookie, so a made-up id is refused before any store is
   * asked (`session-signing.ts`). Omitted, a key is made once and kept in
   * `bakery/session.key`. Servers that share one store need the same secret.
   * Changing it ends every session: their cookies no longer verify.
   */
  secret?: string
}

/**
 * The configured `sessions`, or undefined before `initConfig()`. Sessions are
 * built outside a server too (a unit test, a script), and there the defaults
 * are the answer rather than an error.
 */
function sessionOptions(): SessionOptions | undefined {
  return (hostStore.getStore()?.config ?? peekConfig())?.sessions
}

/** The configured store, or undefined for the built-in one. */
function sessionStore(): SessionStore | undefined {
  return sessionOptions()?.store
}

/** The host `hostKey()` would prefix, without the separator: a store's scope. */
function sessionHost(): string {
  return resolveHostname(hostStore.getStore()?.hostname || '')
}

/**
 * Ids worth a lookup: `newSessionId` mints 43 of these characters. A cookie
 * holding anything else names no session a store could have, and costs no
 * round trip.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The session `attach` read for a request, where `from` finds it. */
const PRELOADED = Symbol('bakery.session.preloaded')

/** A synchronous static that reads the built-in store, called with another configured. */
function builtInOnly(what: string, instead: string): never {
  throw new Error(
    `${what} reads the built-in session store, and sessions.store replaces it: use ${instead}.`,
  )
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
    if (sessionStore()) builtInOnly('Session.count', 'await Session.total()')
    return Session.cache.count
  }

  /**
   * Attach the session cookie to a response built outside the pipeline.
   *
   * **Takes the `Request`, and that is not incidental.** `getCookie` reads the
   * session through `hasDeferredValue(req, 'session')`, which looks for a
   * symbol the router installs, so the value has to come from the real
   * request. There used to be an instance form, `session.bind(res)`, that
   * called this with `{ session: this }`: a fake carrying no symbol, so the
   * check failed, `getCookie` returned an empty string, and the cookie was
   * never appended. It was a documented method that could not work, and it is
   * gone rather than repaired: the session alone does not know whether the
   * request it belongs to issued a cookie this turn.
   */
  public static bind(req: Request, response?: Response) {
    if (sessionStore()) {
      builtInOnly(
        'Session.bind',
        'await Session.commit(req) and append the cookie it returns',
      )
    }
    if (!response) return response

    const cookieValue = Session.getCookie(req)
    if (cookieValue) response.headers.append('Set-Cookie', cookieValue)

    return response
  }

  public static getCookie(req: Request): string {
    if (sessionStore()) {
      builtInOnly('Session.getCookie', 'await Session.commit(req)')
    }
    if (!hasDeferredValue(req, 'session')) return ''
    const session = req.session

    // Ended from outside this request (`Session.delete`, `endForAccount`):
    // storing it again would undo that.
    if (session.ended) return ''

    // Issue only when the session actually changed, or when the read path
    // flagged a half-life refresh (see `markAccessed`), not on every read.
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

    return Session.cookieHeader(session, req)
  }

  /**
   * Write what this request did to its session, and return the `Set-Cookie`
   * value for the response, `''` for none. `processResponse` calls it for
   * every response but a WebSocket upgrade, whose headers are not its to set.
   *
   * With the built-in store this is `getCookie`. With `sessions.store` the
   * writes happen here, awaited, so the response leaves after the store has
   * them: a login answered with a redirect finds its session on the next
   * request, whichever worker takes it.
   */
  public static async commit(req: Request): Promise<string> {
    const store = sessionStore()
    if (!store) return Session.getCookie(req)
    if (!hasDeferredValue(req, 'session')) return ''
    return await req.session.commitTo(store, req)
  }

  /**
   * Give the request its `req.session`. `worker.ts` calls it first, so the
   * rate limiter's `keyBy` and every handler after it read the session
   * synchronously.
   *
   * With the built-in store nothing is read until something asks: the
   * property is deferred, and a request that never touches it costs nothing.
   * A configured store cannot be asked synchronously, so a request carrying a
   * session cookie waits here for one lookup by primary key, and one without
   * a cookie does not wait at all.
   */
  public static attach(req: Request): Promise<void> | undefined {
    deferredValue(req, 'session', Session.from)
    const store = sessionStore()
    if (!store) return undefined

    const id = Session.getSessionId(req)
    if (!SESSION_ID.test(id)) return undefined

    return store.load(sessionHost(), id, clock()).then(stored => {
      // `load` asks for live sessions only. Checked again so a store that
      // forgets to cannot hand back an expired one.
      if (!stored || stored.expiresAt <= clock()) return
      const session = Session.revive(stored)
      session.markAccessed()
      ;(req as any)[PRELOADED] = session
    })
  }

  /** The `Set-Cookie` value naming `session`, for the response to `req`. */
  private static cookieHeader(session: Session<any>, req: Request): string {
    const maxAgeSeconds = Math.floor(session.idleTimeout() / 1000)

    // Only believe x-forwarded-proto behind a trusted proxy: the same rule
    // getHostname and getClientIp already apply. In production default to
    // Secure, so a terminator that omits the header can't downgrade the cookie.
    const trustProxy = Bakery.config.trustProxy
    const forwardedHttps =
      trustProxy && req.headers.get('x-forwarded-proto') === 'https'
    const isHttps = Boolean(
      req.url?.startsWith('https:') || forwardedHttps || import.meta.env.PROD,
    )
    const secureFlag = isHttps ? '; Secure' : ''
    const value = signSessionId(session.id, sessionOptions()?.secret)
    return `sId=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`
  }

  public static delete(reqOrId: string | Request): boolean {
    if (sessionStore()) builtInOnly('Session.delete', 'await Session.end(id)')
    const id = this.getSessionId(reqOrId)
    if (!id) return false
    const key = sessionKey(id)
    // A request holding this session right now must not store it again on
    // its way out. The memory tier hands every request the same object, so
    // marking it reaches them all.
    const live = Session.cache.peek(key)
    if (live) live.ended = true
    return Session.cache.delete(key)
  }

  public static create<T extends MapOf<any>>(metadata: {
    id: string
    persistKeys: string[] | Set<string>
    data: Partial<T>
  }): Session<T> {
    if (sessionStore()) {
      builtInOnly('Session.create', 'req.session, which the response stores')
    }
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
    // `markAccessed` reads as long past half-life, at worst one extra
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
    const value = cookieHeader.match(/(?:^|;\s*)sId=([^;]+)/)?.[1]
    // Signed: an id whose MAC does not match names no session, so neither
    // store is asked about it. See `session-signing.ts`.
    return value ? verifiedSessionId(value, sessionOptions()?.secret) : ''
  }

  public static from<T extends MapOf<any> = MapOf<any>>(
    request: Request,
  ): Session<T> {
    const rawReq = request as any
    if (rawReq._session) return rawReq._session as any
    // A configured store was read by `attach`, before anything could ask.
    if (sessionStore()) return rawReq[PRELOADED] ?? new Session()
    const sessionId = Session.getSessionId(request)

    if (sessionId) {
      const existing = Session.cache.get(sessionKey(sessionId))
      if (existing) {
        // Enforce the TTL on read. Previously expiry relied solely on the
        // 15-minute prune interval, so a stolen id stayed usable past its TTL.
        if (existing.isExpired()) {
          Session.cache.delete(sessionKey(sessionId))
        } else {
          // Accessed, not modified. See `markAccessed`. `touch()` here made
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
   * never (or unknown: a row written before the field existed). Persisted
   * through `toJSON`, so it only costs a write when a write is already
   * happening; while the instance lives in the memory tier it carries across
   * requests for free.
   */
  protected cookieIssuedAt: number = 0

  /**
   * Set by `markAccessed` when the cookie has crossed half its Max-Age;
   * cleared when `getCookie` issues. Deliberately not persisted: it is
   * per-instance request bookkeeping, and losing it costs nothing (the next
   * read recomputes it from `cookieIssuedAt`).
   */
  protected cookieRefreshDue: boolean = false

  protected persistKeys!: Set<string>

  protected rawData: Partial<T> = {}
  public data!: Partial<T>

  /**
   * Ended from outside the request holding it, by `Session.delete`,
   * `Session.end` or `Session.endForAccount`: nothing it writes is stored
   * again. `destroy()` is different: the request ending its own session may
   * go on to start a new one.
   */
  private ended = false

  /**
   * With `sessions.store`: the id the store holds this session under, or null
   * while it holds nothing. It differs from `id` after `regenerate()`, until
   * the commit moves the row.
   */
  private storedId: string | null = null

  /** With `sessions.store`: stored ids to remove at commit, in order. */
  private removals: string[] = []

  /** With `sessions.store`: when the store last wrote it. */
  private storedAccessedAt: number | undefined

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
   * read path: `Session.from` uses `markAccessed`, which slides expiry
   * without paying write costs.
   */
  public touch(): this {
    this.modified = true
    return this
  }

  /**
   * The read-path bump, what `Session.from` does instead of `touch()`.
   * Reading a session must not dirty it: that made every read-only request
   * pay a JSON.stringify + synchronous SQLite write on the next flush and
   * re-issue Set-Cookie, which defeated If-None-Match caching.
   *
   * Liveness needs no work here: the `Session.cache.get` in `from` has
   * already re-stamped the memory tier's accessedAt. What this method owns is
   * sliding cookie expiration: once more than half the cookie's Max-Age has
   * elapsed since it was last issued, flag a reissue. `getCookie` then emits
   * the cookie *and* re-persists the session, which renews the DB row's
   * accessedAt at a cadence of at most maxAge/2 against the pruner's cutoff
   * of maxAge, so active sessions never age out server-side either.
   */
  private markAccessed(): void {
    if (clock() - this.cookieIssuedAt > this.idleTimeout() / 2) {
      this.cookieRefreshDue = true
    }
  }

  /**
   * How long the session lives unused, which is also its cookie's Max-Age:
   * 30 days once a key is persisted, an hour otherwise.
   *
   * `hasPersistedKeys()` rather than `persistedKeys.length`: the getter
   * allocates an Array off the Set purely to read its length.
   */
  private idleTimeout(): number {
    return this.hasPersistedKeys()
      ? DEFAULT_SESSION_PERSIST
      : DEFAULT_SESSION_TTL
  }

  public get isModified() {
    return this.modified
  }
  public get accessedAt() {
    return (
      this.storedAccessedAt ??
      Session.cache.getAccessedAt(sessionKey(this.id)) ??
      Date.now()
    )
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
    return Date.now() - this.accessedAt > this.idleTimeout()
  }

  public persist(key: keyof T | (string & {}), state: boolean = true): this {
    this.persistKeys[state ? 'add' : 'delete'](key as string)
    this.modified = true

    // A configured store writes at commit, like every other change.
    if (this.persistKeys.size > 0 && !sessionStore()) {
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
   * finishes authentication on the *same* id the visitor arrived with,
   * including one an attacker planted. Call it at the privilege boundary:
   *
   * ```ts no-check: illustrative call site, not a compiled example
   * req.session.regenerate().set('userId', user.id, true)
   * ```
   *
   * Marking the session modified is what re-issues the cookie: `getCookie`
   * emits `sId=` from the current id and only when `modified` is set, and it is
   * the same object `req.session` already holds, so the rest of the request
   * sees the new id.
   *
   * `createdAt` is deliberately preserved: the session continues, only its
   * bearer token is replaced.
   */
  public regenerate(): this {
    const previous = this.id
    // `id` is readonly to callers; rotating it is the one legitimate write.
    ;(this as { id: string }).id = newSessionId()

    // A configured store moves the row at commit, from `storedId` to the new
    // id in one statement, so a session ended meanwhile is not recreated
    // under its new name.
    if (!sessionStore()) {
      Session.cache.delete(sessionKey(previous))
      Session.cache.set(sessionKey(this.id), this)
    }
    this.modified = true

    return this
  }

  public reset(full = false): void {
    if (full) this.persistKeys.clear()

    for (const key of Object.keys(this.rawData)) {
      if (this.persistKeys.has(key)) continue
      delete this.rawData[key as keyof T]
    }

    const store = sessionStore()
    if (!this.hasPersistedKeys()) {
      if (store) this.forgetStored()
      else Session.cache.delete(sessionKey(this.id))
      this.modified = false
      // A pending half-life refresh would make `getCookie` re-store the
      // session this branch just deleted.
      this.cookieRefreshDue = false
    } else if (store) {
      this.modified = true
    } else {
      Session.cache.set(sessionKey(this.id), this)
    }
  }

  /**
   * With `sessions.store`: remove the stored row at commit, and store
   * anything written after this as a session of its own.
   */
  private forgetStored(): void {
    if (this.storedId !== null) this.removals.push(this.storedId)
    this.storedId = null
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

  /**
   * End this session, and leave in its place a new one that nothing has
   * written to.
   *
   * Dropping the stored entry was never enough on its own, because the object
   * outlives the call: the same `req.session` reaches `getCookie` on the way
   * out, and `getCookie` stores whatever is modified or due a cookie refresh.
   * A login past half its cookie's Max-Age is due one, and a flash message
   * written after the logout marks it modified, so either brought the whole
   * session back, account id and all, under the id the visitor still held.
   *
   * So the object becomes a new session: a fresh id, no data, nothing
   * persisted, nothing due. A request that stops here stores nothing and
   * issues no cookie; one that goes on writing starts an anonymous session of
   * its own, which the response issues as usual.
   */
  public destroy(): void {
    if (sessionStore()) this.forgetStored()
    else Session.cache.delete(sessionKey(this.id))
    ;(this as { id: string }).id = newSessionId()
    ;(this as { createdAt: number }).createdAt = Date.now()
    this.persistKeys.clear()
    for (const key of Object.keys(this.rawData)) {
      delete this.rawData[key as keyof T]
    }
    this.modified = false
    this.cookieRefreshDue = false
    this.cookieIssuedAt = 0
    this.ended = false
  }

  /**
   * With `sessions.store`, the writes `commit` makes: the removals first and
   * in order, then the session itself.
   *
   * One statement at a time, never in parallel. A pool can run two
   * statements on two connections, and a removal overtaken by the insert
   * queued after it (`reset()` then a write keeps the id) would remove the
   * session just written.
   */
  private async commitTo(store: SessionStore, req: Request): Promise<string> {
    const host = sessionHost()
    for (const id of this.removals.splice(0)) await store.remove(host, id)
    if (this.ended || (!this.modified && !this.cookieRefreshDue)) return ''

    const now = clock()
    const stored = this.toStored(host, now)
    let kept = true
    if (this.storedId === null) await store.insert(stored)
    else if (this.modified) kept = await store.update(this.storedId, stored)
    else kept = await store.touch(host, this.storedId, now, stored.expiresAt)

    if (!kept) {
      // Ended after this request read it: by `endForAccount`, by a logout in
      // another tab, in this worker or another. Writing it back would undo
      // that, and a new cookie would name a session that is not there.
      this.ended = true
      return ''
    }

    this.storedId = this.id
    this.storedAccessedAt = now
    this.cookieIssuedAt = now
    this.modified = false
    this.cookieRefreshDue = false
    return Session.cookieHeader(this, req)
  }

  /**
   * As a store keeps it, last written at `accessedAt`. The account is read
   * off the key `sessions.account` names, as text, so `7` and `'7'` are one
   * account.
   */
  private toStored(host: string, accessedAt: number): StoredSession {
    const key = sessionOptions()?.account
    const held = key ? (this.rawData as MapOf<unknown>)[key] : undefined
    return {
      id: this.id,
      host,
      account:
        held === undefined || held === null || held === ''
          ? null
          : String(held),
      createdAt: this.createdAt,
      accessedAt,
      expiresAt: accessedAt + this.idleTimeout(),
      persistKeys: Array.from(this.persistKeys),
      data: { ...this.rawData },
    }
  }

  /** A session read from a store, remembering where it is stored. */
  private static revive(stored: StoredSession): Session<any> {
    const session = Session.reconstruct({
      id: stored.id,
      createdAt: stored.createdAt,
      persistKeys: stored.persistKeys,
      data: stored.data,
      // A store writes a session exactly when its cookie is issued.
      cookieIssuedAt: stored.accessedAt,
    })
    session.storedId = stored.id
    session.storedAccessedAt = stored.accessedAt
    return session
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

  /**
   * The live session under this id, on the current host. With a configured
   * store this is a copy read for the caller: change it, then
   * `await Session.save(session)`.
   */
  static async get(sessid: string): Promise<Session<any> | undefined> {
    const store = sessionStore()
    if (!store) return Session.cache.get(sessionKey(sessid))
    const stored = await store.load(sessionHost(), sessid, clock())
    return stored ? Session.revive(stored) : undefined
  }

  /**
   * End the session under this id, on the current host: true when there was
   * one. Unlike `Session.delete`, works with any store.
   *
   * A request holding that session right now finishes with what it read,
   * and writes nothing back on its way out.
   */
  static async end(sessid: string): Promise<boolean> {
    const store = sessionStore()
    if (!store) return Session.delete(sessid)
    return await store.remove(sessionHost(), sessid)
  }

  /**
   * End every session of one account, on the current host: how many there
   * were. The account is matched as text against the session key that
   * `sessions.account` names, so `7` and `'7'` are one account.
   *
   * With a configured store this is one indexed `DELETE`, and since nothing
   * caches a session between requests, the next request in every worker
   * finds none. Inside `DB.transaction()` the database store takes part in
   * the transaction, so removing an account and its sessions can be one
   * commit. With the built-in store it ends what this process holds, which
   * under `--threads` is not what another worker holds in its memory: that is
   * the case the database store exists for.
   */
  static async endForAccount(account: string | number): Promise<number> {
    const key = sessionOptions()?.account
    if (!key) {
      throw new Error(
        'Session.endForAccount needs sessions.account in server.config.ts: the session key that holds the account id.',
      )
    }
    const wanted = String(account)
    const store = sessionStore()
    if (store) return await store.removeAccount(sessionHost(), wanted)

    // Collected first and deleted after: deleting rows from the table a
    // statement is still walking is not something SQLite promises to handle.
    const ended: string[] = []
    for (const [id, session] of Session.entries()) {
      const held = (session.rawData as MapOf<unknown>)[key]
      if (held !== undefined && held !== null && String(held) === wanted) {
        ended.push(id)
      }
    }
    for (const id of ended) Session.delete(id)
    return ended.length
  }

  /** How many sessions are live, across every host. Works with any store. */
  static async total(): Promise<number> {
    const store = sessionStore()
    return store ? await store.count(clock()) : Session.cache.count
  }

  /**
   * One page of the current host's sessions, as `Session.list` gives it, from
   * any store. Sorted by `'id'`, `'keys'` (how many are persisted) or last
   * access, the default.
   */
  static async page(options: SessionListOptions): Promise<SessionPage> {
    const store = sessionStore()
    if (!store) return Session.list(options)
    const { rows, totalRows } = await store.list(
      sessionHost(),
      options,
      clock(),
    )
    const totalPages = Math.max(1, Math.ceil(totalRows / options.pageSize))
    return {
      rows: rows.map(Session.revive),
      totalRows,
      page: Math.min(Math.max(1, options.page), totalPages),
      pageSize: options.pageSize,
      totalPages,
    }
  }

  /**
   * Store a session changed outside its own requests, such as one an admin
   * edits from `Session.get`. False when it has been ended meanwhile, and
   * then it stays ended.
   *
   * Its last access is left alone. With a configured store that time is
   * when the session's cookie was issued, and moving it on an edit would
   * delay the owner's cookie refresh past the cookie's own expiry.
   */
  static async save(session: Session<any>): Promise<boolean> {
    const store = sessionStore()
    if (!store) {
      Session.cache.set(sessionKey(session.id), session)
      return true
    }
    if (session.ended) return false
    const stored = session.toStored(
      sessionHost(),
      session.storedAccessedAt ?? clock(),
    )
    if (session.storedId === null) await store.insert(stored)
    else if (!(await store.update(session.storedId, stored))) return false
    session.storedId = session.id
    session.storedAccessedAt = stored.accessedAt
    return true
  }

  /**
   * Every enumeration below filters to the current host and yields the bare
   * session id, not the cache key, so `Session.keys()` still returns ids the
   * dashboard can hand back to `Session.get` / `Session.delete`.
   *
   * They read the built-in store, synchronously, and refuse when a configured
   * store replaces it: `Session.page()` and `Session.total()` ask any store.
   */
  static *entries(): IterableIterator<[string, Session<any>]> {
    if (sessionStore()) builtInOnly('Session.entries', 'await Session.page()')
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

  static list(options: SessionListOptions): SessionPage {
    if (sessionStore()) builtInOnly('Session.list', 'await Session.page()')
    // Fast path: with no `hosts` configured every key is already in the default
    // bucket, so the cache's own SQL paging is correctly scoped and there is no
    // reason to give it up.
    //
    // The check is on `hosts` and not on the scope, deliberately: `hostKey`
    // collapses to '' in the unconfigured case too, so the scope alone cannot
    // tell the two situations apart. This method used to compute one anyway and
    // never read it: scoping lives in `Session.entries()`, which the slow path
    // below goes through.
    const hosts = Bakery.config.hosts
    if (!hosts || Object.keys(hosts).length === 0) {
      return Session.cache.search(options)
    }

    // Scoped path: `TieredCache.search` pages in SQL across the whole table,
    // which is every tenant's sessions, and it has no key-prefix predicate, so
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
    // Every worker runs this timer. Against a shared store that is one
    // indexed DELETE each per quarter hour, and a second finds nothing.
    const store = sessionStore()
    if (store) {
      store
        .prune(clock())
        .catch(error => serveLog.SESSION_PRUNE_ERR({ error: errorMsg(error) }))
      return
    }
    Session.cache.prune(DEFAULT_SESSION_TTL, '$.persistKeys')
    Session.cache.prune(DEFAULT_SESSION_PERSIST)
  },
  1000 * 60 * 15, // prune every 15 minutes
)

// Unref'd, like the two flush timers in `cache/`. A 15-minute prune is not a
// reason a process cannot exit, and this one is module-level: importing
// `session.ts` (which `core/index` does) held the event loop open for the
// life of any process that touched core. The CLI never saw it because every
// one of its paths ends in `process.exit`; a script, an embedder or a bare
// `bun -e` that imported the barrel printed its answer and then hung.
// `onShutdown` still clears it, which is what matters for an orderly stop.
sessionPruneTimer.unref?.()

Bakery.onShutdown(() => {
  clearInterval(sessionPruneTimer)
})
