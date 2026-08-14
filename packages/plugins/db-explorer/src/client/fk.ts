/**
 * Foreign keys: what a cell points at, and what it costs to find out.
 *
 * The naive version of this feature is a `fetch` per foreign-key cell on
 * `mouseover`. A fifty-row page with three foreign keys is a hundred and fifty
 * requests, and moving the mouse across the grid fires most of them. Three
 * things prevent that here, and all three are load-bearing:
 *
 *  - **A ~350 ms arming delay.** Crossing a cell on the way somewhere else
 *    never issues a request.
 *  - **An `AbortController`.** `pointerleave` cancels a request already in
 *    flight, so a fast sweep costs one aborted socket rather than fifty
 *    completed round trips.
 *  - **A bounded cache** (convention 6). The key is `table|col|value`, which is
 *    per-row and therefore unbounded in principle; the bound is what makes that
 *    safe.
 *
 * The pure half — which column points where, and what key a row implies — is
 * separated out so the graph reasoning can be read without the timers.
 */

import { type LookupRef, lookupRefs } from './api'
import { type ForeignKeyInfo, type SchemaGraph, sameTable } from './meta'

/**
 * A least-recently-used map, in nine lines.
 *
 * Core has `LRUCache` and this is not a preference for a private copy —
 * `bundleModule` externalises every installed package, so importing it leaves
 * `@bakery-framework/core/cache/lru` as a bare specifier in the emitted bundle
 * and the browser cannot resolve it. Client code imports nothing from
 * `@bakery-framework/*`; see the header of `shared/coerce.ts`.
 *
 * A `Map` iterates in insertion order, so re-inserting on read is the whole
 * recency mechanism and the oldest key is always the first one.
 */
class BoundedCache<V> {
  private readonly map = new Map<string, V>()
  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}


export interface FkTarget {
  /** Columns in *this* table that make up the key. */
  cols: string[]
  refTable: string
  /** The matching columns in the referenced table, positionally. */
  refCols: string[]
}

function toTarget(fk: ForeignKeyInfo): FkTarget {
  return { cols: fk.cols, refTable: fk.refTable, refCols: fk.refCols }
}

/**
 * The foreign key `column` participates in, if any.
 *
 * Composite keys are included rather than skipped: a two-column key renders as
 * a button on each of its columns, and both resolve the same referenced row.
 * Skipping them would make the feature quietly absent on exactly the schemas
 * where following a reference by hand is hardest.
 */
export function fkForColumn(
  graph: SchemaGraph | null,
  table: string,
  column: string,
): FkTarget | null {
  if (!graph) return null
  for (const fk of Object.values(graph.foreignKeys)) {
    if (!sameTable(fk.table, table)) continue
    if (fk.cols.includes(column)) return toTarget(fk)
  }
  return null
}

/** Every key pointing *at* this table. The row panel's "referenced by" list. */
export function reverseFks(
  graph: SchemaGraph | null,
  table: string,
): ForeignKeyInfo[] {
  if (!graph) return []
  return Object.values(graph.foreignKeys).filter(fk =>
    sameTable(fk.refTable, table),
  )
}

/**
 * The referenced row's identity, as this row names it.
 *
 * `null` when any participating column is NULL — an optional foreign key with
 * no value points at nothing, and a predicate containing `NULL` matches no row
 * anyway, so issuing the lookup would spend a request to learn that.
 */
export function fkKeyOf(
  target: FkTarget,
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  const key: Record<string, unknown> = {}
  for (let i = 0; i < target.cols.length; i++) {
    const value = row[target.cols[i]!]
    if (value === null || value === undefined) return null
    key[target.refCols[i] ?? target.cols[i]!] = value
  }
  return key
}

/** `table|col|value` — stable across pages, which is what makes caching pay. */
export function cacheKey(
  refTable: string,
  key: Record<string, unknown>,
): string {
  const parts = Object.keys(key)
    .sort()
    .map(column => `${column}=${String(key[column])}`)
  return `${refTable}|${parts.join('|')}`
}

/**
 * What to show for a resolved row: the label column if the table has one, the
 * identity otherwise.
 *
 * `graph.labels` is the server's pick — the first text column that is not part
 * of the identity — so a `users` row reads as `ada` rather than `41`.
 */
export function fkLabel(
  graph: SchemaGraph | null,
  refTable: string,
  row: Record<string, unknown> | null,
): string | null {
  if (!row) return null
  const label = graph?.labels?.[refTable]
  if (label && row[label] !== null && row[label] !== undefined) {
    return String(row[label])
  }
  const identity = graph?.identity?.[refTable]?.cols ?? Object.keys(row)
  return identity.map(column => String(row[column])).join(' / ')
}

export type Resolved = Record<string, unknown> | null

/**
 * Hover-driven resolution, with the cache and the cancellation.
 *
 * One instance per page load, cleared when the schema graph is refetched.
 */
export class FkResolver {
  /**
   * 500 entries — ten pages of a fifty-row grid with a foreign key on every
   * row. Past that the earliest are the ones the user has scrolled away from.
   */
  private readonly cache = new BoundedCache<Resolved>(500)
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: AbortController | null = null

  cached(refTable: string, key: Record<string, unknown>): Resolved | undefined {
    return this.cache.get(cacheKey(refTable, key))
  }

  /**
   * Arm the delay. Returns a canceller for `pointerleave`.
   *
   * The canceller aborts an in-flight request as well as clearing an unfired
   * timer, because the expensive case is the one that already left.
   */
  arm(
    refTable: string,
    key: Record<string, unknown>,
    onResolved: (row: Resolved) => void,
    delay = 350,
  ): () => void {
    const hit = this.cached(refTable, key)
    if (hit !== undefined) {
      onResolved(hit)
      return () => {}
    }
    this.cancel()
    this.timer = setTimeout(() => {
      void this.resolve(refTable, key).then(onResolved, () => {
        // An abort or a failed lookup leaves the cell showing its raw value,
        // which is the state it was already in. Nothing to report: the user
        // moved the pointer away, or the row is simply not resolvable.
      })
    }, delay)
    return () => this.cancel()
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.inflight?.abort()
    this.inflight = null
  }

  /** One batched lookup. Public so the panel can resolve without hovering. */
  async resolve(
    refTable: string,
    key: Record<string, unknown>,
  ): Promise<Resolved> {
    const hit = this.cached(refTable, key)
    if (hit !== undefined) return hit

    const controller = new AbortController()
    this.inflight = controller
    const refs: LookupRef[] = [{ table: refTable, key }]
    const rows = await lookupRefs(refs, controller.signal)
    this.inflight = null

    const row = rows[0]?.row ?? null
    this.cache.set(cacheKey(refTable, key), row)
    return row
  }

  clear(): void {
    this.cancel()
    this.cache.clear()
  }
}
