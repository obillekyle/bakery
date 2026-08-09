import type { PoolOptions } from '../pool'
import type { SQLAdapter } from './base'

/**
 * Every driver name the ORM knows, as an interface so a third-party adapter can
 * add its own.
 *
 * A union type cannot be extended from outside the package, and widening it to
 * `string` would give up every place the compiler currently catches a typo — so
 * this is an interface and a new name arrives by declaration merging, the same
 * mechanism `DBSchema` already uses for an app's tables:
 *
 * ```ts no-check — a third-party package's own declaration file
 * declare module '@bakery/orm/adapters' {
 *   interface DriverRegistry {
 *     mssql: true
 *   }
 * }
 * ```
 *
 * `@bakery/orm/adapters` — the public subpath — and not this file, which is
 * private and does not resolve from outside the package. The merge reaches
 * through the barrel's `export *`; aiming it at an unresolvable specifier
 * instead declares a second, unrelated interface and leaves every driver name
 * rejected with nothing pointing at the cause.
 *
 * The value type is `true` and carries nothing: only the *keys* are read. It
 * is a set spelled as an interface, because interfaces are what TypeScript
 * lets you merge into.
 */
export interface DriverRegistry {
  sqlite: true
  postgres: true
  mysql: true
}

/** A registered driver name. Extend {@link DriverRegistry} to add one. */
export type Driver = keyof DriverRegistry & string

export interface AdapterSpec {
  /**
   * The driver name, which is also the registry key: registering twice under
   * one name replaces the earlier entry rather than adding a second.
   */
  driver: Driver

  /**
   * URL schemes this adapter answers to, without `://`.
   *
   * Checked first and exactly — `mysql://…` reaches the adapter that listed
   * `mysql`, and nothing else is consulted. List every spelling you accept;
   * the built-in MySQL adapter lists four.
   */
  protocols?: readonly string[]

  /**
   * Last resort, for a target no scheme matched — a bare file path, say.
   *
   * Consulted in reverse registration order, so an adapter registered later can
   * claim a target one of the built-ins would otherwise have taken. Return
   * `false` (or omit the hook) to pass.
   */
  matches?(target: string): boolean

  /**
   * Open a connection. `target` is the raw `DB_URL`, or `undefined` when none
   * was set and this adapter is the default.
   *
   * Async so the implementation can `await import()` its own driver module —
   * which is how the three built-ins stay lazy: registering all of them costs
   * three object literals, and only the one that wins is ever loaded.
   */
  open(
    target: string | undefined,
    pool: PoolOptions,
  ): SQLAdapter | Promise<SQLAdapter>
}

/**
 * What to fall back to when the target names no adapter — split in two because
 * the two cases have never had the same answer. See {@link resolveDriver}.
 */
export interface DriverFallback {
  /** No `DB_URL` at all. */
  empty: Driver
  /** A target that matched no scheme and no `matches()` hook. */
  unknown: Driver
}

export const DEFAULT_FALLBACK: DriverFallback = {
  empty: 'sqlite',
  unknown: 'postgres',
}

/**
 * A stack per driver name, not one entry per name.
 *
 * Registering over an existing driver is temporary far more often than it is
 * permanent — a test swapping in a fake, an app overriding a built-in for one
 * environment — so "undo" has to give back exactly what was displaced. One
 * entry per name cannot: release two registrations out of order and the second
 * disposer restores the first's spec, quietly leaving a stub adapter installed
 * for the rest of the process. A stack makes the order irrelevant, which is the
 * only version that is safe to hand to a test.
 *
 * The Map's own order is first-registration order of each *name*, which is what
 * `listAdapters` and the reverse scans in `resolveDriver` read.
 */
const stacks = new Map<string, AdapterSpec[]>()

/**
 * Add an adapter. An existing one under the same driver name is pushed down,
 * not discarded.
 *
 * Returns a function that removes exactly this registration, whenever it is
 * called and in any order relative to other disposers. A registry with no way
 * out is a leak by construction.
 */
export function registerAdapter(spec: AdapterSpec): () => void {
  const stack = stacks.get(spec.driver) ?? []
  stack.push(spec)
  stacks.set(spec.driver, stack)
  return () => {
    const live = stacks.get(spec.driver)
    if (!live) return
    const at = live.lastIndexOf(spec)
    if (at === -1) return
    live.splice(at, 1)
    if (!live.length) stacks.delete(spec.driver)
  }
}

/** The registered adapter for a driver name, or `undefined`. */
export function getAdapter(driver: string): AdapterSpec | undefined {
  return stacks.get(driver)?.at(-1)
}

/** Every registered adapter, one per driver, in registration order. */
export function listAdapters(): AdapterSpec[] {
  return [...stacks.keys()].map(d => getAdapter(d)!).filter(Boolean)
}

/**
 * Which adapter should open `target`.
 *
 * The order is the whole contract, so it is stated rather than left to be read
 * out of the code:
 *
 * 1. **No target at all** → `fallback` (`sqlite`), so a fresh app with no
 *    `DB_URL` gets a file database rather than an error.
 * 2. **A URL scheme** that some adapter declared → that adapter, exactly.
 * 3. **`matches()`**, in reverse registration order — later registrations get
 *    first refusal, which is what makes overriding a built-in possible.
 * 4. **`fallback`** otherwise, which for a target that looked like a host is
 *    `postgres`. Long-standing behaviour, kept deliberately: a bare
 *    `db.internal:5432/app` has been read as Postgres since before the
 *    registry existed.
 *
 * Throws only if the resolved driver has no adapter registered — which means
 * something registered a `protocols` entry and then unregistered itself, not
 * anything a user can reach by typing a URL.
 */
export function resolveAdapter(
  target: string,
  fallback: DriverFallback = DEFAULT_FALLBACK,
): AdapterSpec {
  const driver = resolveDriver(target, fallback)
  const spec = getAdapter(driver)
  if (!spec) {
    throw new Error(
      `No adapter registered for driver '${driver}'. ` +
        `Registered: ${[...stacks.keys()].join(', ') || '(none)'}.`,
    )
  }
  return spec
}

/** Step 1–4 of {@link resolveAdapter}, without the lookup. */
export function resolveDriver(
  target: string,
  fallback: DriverFallback = DEFAULT_FALLBACK,
): Driver {
  const trimmed = target.trim()
  if (!trimmed) return fallback.empty

  // Newest first in both loops, so registering over a built-in is enough to
  // take its protocols as well as its heuristics. Registration order alone
  // would make an override depend on which module happened to load first.
  const newestFirst = listAdapters().reverse()

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme) {
    for (const spec of newestFirst) {
      if (spec.protocols?.some(p => p.toLowerCase() === scheme))
        return spec.driver
    }
  }

  for (const spec of newestFirst) {
    if (spec.matches?.(trimmed)) return spec.driver
  }

  return fallback.unknown
}
