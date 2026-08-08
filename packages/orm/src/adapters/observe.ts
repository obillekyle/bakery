import { Try } from '@bakery/core/utils'
import type { SQLAdapter } from './base'

/**
 * Query observability: one callback, called once per executed statement.
 *
 * Deliberately **not** an emitter and **not** a listener array. This sits in
 * the hot path of every statement the ORM runs, so the cost of having the
 * feature at all has to be a single null read when nobody is watching — see
 * `observe()` below, which returns the driver's own value untouched in that
 * case. An emitter would allocate an event object and walk a list per query
 * whether or not anything subscribed.
 *
 * Process-wide rather than per-adapter, on purpose. Every adapter builds a
 * *new* adapter instance per transaction (`SQLiteAdapter.transaction` wraps the
 * transaction handle in a fresh `SQLiteAdapter`), so a hook attached to one
 * instance would go silent for exactly the statements a slow-query panel most
 * wants to see. `driver` is on the event instead, so a process talking to two
 * databases can still tell them apart.
 */

export type QueryMethod = 'all' | 'run' | 'get' | 'values' | 'iterate'

export interface QueryEvent {
  /** The statement as handed to the driver, before dialect normalisation. */
  sql: string
  /** Wall-clock duration in milliseconds, fractional. */
  ms: number
  /**
   * Rows the statement produced, or `null` when it cannot be known — a failed
   * statement, or a result shape the adapter does not describe as an array.
   * For `run` this is the *affected* row count, not a result set.
   */
  rows: number | null
  driver: SQLAdapter.Driver
  /** Which executor entry point ran. See the note on `iterate` in `ms`. */
  method: QueryMethod
  /** `null` when the statement succeeded; the thrown value otherwise. */
  error: unknown
  /**
   * Bound parameter **values**, present only when the observer was registered
   * with `{ params: true }`.
   *
   * Security decision, and the reason this is opt-in with the default off:
   * parameters are user data. A query's bindings routinely hold passwords,
   * session tokens, API keys and personal information, and anything an
   * observer receives is one `logger.info` away from a log file, an analytics
   * table or a dashboard panel. Defaulting this on would turn "add a slow
   * query panel" into a credential leak that nobody reviewed. Callers that
   * genuinely need bindings — a local query profiler, say — must ask, and are
   * then responsible for what they do with them.
   */
  params?: readonly unknown[]
}

export type QueryObserver = (event: QueryEvent) => unknown

export interface QueryObserverOptions {
  /**
   * Include bound parameter values on every event. Defaults to `false`.
   * Read the note on `QueryEvent.params` before turning this on.
   */
  params?: boolean
}

let observer: QueryObserver | null = null
let includeParams = false

/**
 * Install (or with `null`, remove) the process-wide query observer.
 *
 * Returns a disposer that clears the observer only if it is still the one this
 * call installed, so a test that forgets to restore cannot silently unhook a
 * later one.
 *
 * ```ts no-check — illustrative: the app decides where slow queries go
 * import { setQueryObserver } from '@bakery/orm'
 *
 * setQueryObserver(event => {
 *   if (event.ms > 100) slowQueries.push(event)
 * })
 * ```
 */
export function setQueryObserver(
  next: QueryObserver | null,
  options: QueryObserverOptions = {},
): () => void {
  observer = next
  includeParams = next ? options.params === true : false
  const installed = next
  return () => {
    if (observer !== installed) return
    observer = null
    includeParams = false
  }
}

/** The observer currently installed, if any. Mainly for tests and diagnostics. */
export function getQueryObserver(): QueryObserver | null {
  return observer
}

function emit(event: QueryEvent, params: unknown[]): void {
  const fn = observer
  // Re-read rather than trusting the caller's check: an observer may be
  // uninstalled while a query is in flight.
  if (!fn) return
  if (includeParams) event.params = params
  // An observer is application code in the middle of somebody's query. A
  // throwing or rejecting hook is the observer's bug, and it must not become
  // the caller's failed write.
  Try(() => fn(event))
}

type Exec<R> = (sqlText: string, params?: unknown[]) => Promise<R> | R

async function timed<R>(
  driver: SQLAdapter.Driver,
  method: QueryMethod,
  fn: Exec<R>,
  countRows: (result: R) => number | null,
  sqlText: string,
  params: unknown[],
): Promise<R> {
  const started = performance.now()
  try {
    const result = await fn(sqlText, params)
    emit(
      {
        sql: sqlText,
        ms: performance.now() - started,
        // Called bare, not through `Try`: every `countRows` passed in from
        // `createExecutor` is total by construction, and wrapping it cost more
        // per query than the guard was worth.
        rows: countRows(result),
        driver,
        method,
        error: null,
      },
      params,
    )
    return result
  } catch (error) {
    emit(
      {
        sql: sqlText,
        ms: performance.now() - started,
        rows: null,
        driver,
        method,
        // Normalised so `error` is a reliable "did this throw" signal: a driver
        // that rejects with `undefined` would otherwise be indistinguishable
        // from success.
        error: error ?? new Error('query failed with no error value'),
      },
      params,
    )
    throw error
  }
}

/**
 * Wrap one executor entry point so it reports to the observer.
 *
 * The unobserved path is the `if` below and nothing else: no timer read, no
 * event object, and the underlying call's own return value — which for `all`
 * and `run` may legitimately be synchronous — passes straight through.
 */
export function observe<R>(
  driver: SQLAdapter.Driver,
  method: QueryMethod,
  fn: (sqlText: string, params?: unknown[]) => Promise<R>,
  countRows: (result: R) => number | null,
): (sqlText: string, params?: unknown[]) => Promise<R>
export function observe<R>(
  driver: SQLAdapter.Driver,
  method: QueryMethod,
  fn: Exec<R>,
  countRows: (result: R) => number | null,
): (sqlText: string, params?: unknown[]) => Promise<R> | R
// Two overloads because the executor's five entry points are not one shape.
// `get` and `values` are declared to return a promise unconditionally, while
// `all` and `run` may legitimately be synchronous — and the implementation
// signature, which has to admit both, cannot narrow to the former on its own.
// Without the first overload `createExecutor` fails to satisfy `Executor`.
export function observe<R>(
  driver: SQLAdapter.Driver,
  method: QueryMethod,
  fn: Exec<R>,
  countRows: (result: R) => number | null,
): (sqlText: string, params?: unknown[]) => Promise<R> | R {
  return (sqlText: string, params: unknown[] = []) => {
    if (!observer) return fn(sqlText, params)
    return timed(driver, method, fn, countRows, sqlText, params)
  }
}

/**
 * `iterate` is a stream, so its duration means something different from the
 * other four, and the choice here is deliberate:
 *
 * - `ms` spans from the call to `iterate()` until iteration **ends** — the
 *   generator is exhausted, throws, or the consumer breaks out of the loop.
 *   That includes whatever the consumer did between yields, so an `iterate`
 *   event is not comparable with an `all` event and must not be averaged into
 *   the same "query time" number. It is still the useful measure: for a stream,
 *   the interesting quantity is how long the statement held a cursor open.
 * - `rows` counts rows **consumed**, not rows matched. A consumer that breaks
 *   after ten rows of a million-row scan reports ten.
 * - Exactly one event, emitted from `finally`, so an early `break` (which
 *   resumes the generator with a return completion, skipping `catch`) still
 *   reports.
 */
async function* drain(
  driver: SQLAdapter.Driver,
  source: AsyncIterable<SQLAdapter.RowRecord> | Iterable<SQLAdapter.RowRecord>,
  sqlText: string,
  params: unknown[],
  started: number,
): AsyncIterable<SQLAdapter.RowRecord> {
  let rows = 0
  let error: unknown = null
  try {
    for await (const row of source) {
      rows++
      yield row
    }
  } catch (err) {
    error = err ?? new Error('iteration failed with no error value')
    throw err
  } finally {
    emit(
      {
        sql: sqlText,
        ms: performance.now() - started,
        rows,
        driver,
        method: 'iterate',
        error,
      },
      params,
    )
  }
}

export function observeIterate(
  driver: SQLAdapter.Driver,
  iterate: SQLAdapter.Executor['iterate'],
): SQLAdapter.Executor['iterate'] {
  return (sqlText: string, params: unknown[] = []) => {
    if (!observer) return iterate(sqlText, params)
    // The source is created here rather than inside `drain`, and `started` with
    // it: an async generator body does not run until the first `next()`, so
    // both would otherwise be deferred to whenever the consumer got round to
    // pulling — and the statement would be issued later than it is today.
    const started = performance.now()
    return drain(driver, iterate(sqlText, params), sqlText, params, started)
  }
}
