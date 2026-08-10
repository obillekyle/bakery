import { Case } from '@bakery-framework/core/utils'
import type { SQLAdapter } from '../adapters/base'
import type * as SyncTypes from './types'

/**
 * A record, inside the database, of the schema Bakery last applied to it.
 *
 * **Why this exists.** Sync has always compared your TypeScript schema against
 * live introspection, which means reconstructing *intent* from whatever the
 * dialect reports back. Nearly every sync bug this project has had is that
 * reconstruction going wrong: Postgres re-rendering `''` as
 * `''::character varying`, MySQL reporting `information_schema` columns
 * uppercase, `tinyint(1)` versus `data_type`, `EXTRACT` rewritten to
 * `date_part` on older servers, an empty-string default parsed into the number
 * zero. Each one produced a column that differed from itself forever, rebuilding
 * the table on every single sync.
 *
 * Comparing against what we *wrote down* removes that whole class. Two JSON
 * objects, no dialect spellings, no normalisation — and it can carry things
 * introspection cannot report reliably, such as a `VARCHAR` width.
 *
 * **Why it is not simply trusted.** Introspection cannot lie about what exists;
 * a ledger can. If someone alters the database outside Bakery, the ledger is
 * stale, and migrating from a stale premise is worse than a spurious rebuild —
 * it can drop a column somebody added. So the ledger is used only when its
 * *shape* still matches the live database, and shape is checked by comparing
 * table and column names, which needs no normalisation and therefore cannot
 * suffer the bugs above. Anything else falls back to introspection.
 *
 * One consequence to know: **MySQL commits DDL implicitly**, so the schema
 * change and the ledger write cannot be one atomic unit there. A crash between
 * them leaves the ledger behind, which the shape check then catches — it fails
 * safe, toward introspection.
 */
export const LEDGER_TABLE = '__bakery_schema'

/** Append-only: each successful sync adds a row, so history comes free. */
async function ensureTable(adapter: SQLAdapter): Promise<void> {
  const q = (s: string) => adapter.quote(s)
  const id = adapter.colDef({
    type: 'integer',
    autoIncrement: true,
    primary: true,
  })
  const at = adapter.colDef({ type: 'integer' })
  const payload = adapter.colDef({ type: 'string' })
  await adapter
    .query(
      `CREATE TABLE IF NOT EXISTS ${q(LEDGER_TABLE)} (` +
        `${q('id')} ${id}, ${q('applied_at')} ${at}, ${q('payload')} ${payload})`,
    )
    .run()
}

/** One applied schema, as stored. */
export interface LedgerEntry {
  id: number
  appliedAt: number
  constraints: SyncTypes.DBConstraints
  /**
   * Absent on rows written before the payload carried indexes — see
   * {@link parsePayload}. `undefined` means "not recorded", which is not the
   * same as `{}` ("recorded, and there were none"), and `db:rollback` refuses
   * the difference rather than guessing.
   */
  indexes?: SyncTypes.DBIndexes
}

/**
 * A stored payload, in either shape it can have.
 *
 * v1 rows are a bare `DBConstraints` object; v2 wraps constraints alongside the
 * indexes that were applied with them. The version is detected by the `v` key
 * rather than by a column, so existing rows keep working with no migration of
 * the migration table — which would be a fine joke and a bad idea.
 *
 * Indexes were missing from v1 because the ledger only ever fed the *diff*,
 * which reads constraints. `db:rollback` replays a stored schema as a target,
 * and a target with no indexes means "drop every index" — so the payload had to
 * grow before rollback could be honest.
 */
function parsePayload(
  raw: unknown,
): Omit<LedgerEntry, 'id' | 'appliedAt'> | null {
  if (typeof raw !== 'string') return null
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (
    parsed.v === 2 &&
    parsed.constraints &&
    typeof parsed.constraints === 'object'
  ) {
    return {
      constraints: parsed.constraints,
      indexes:
        parsed.indexes && typeof parsed.indexes === 'object'
          ? parsed.indexes
          : undefined,
    }
  }
  // v1: the object *is* the constraints. No `indexes` key to report.
  return 'v' in parsed ? null : { constraints: parsed }
}

/**
 * Every applied schema, newest first.
 *
 * Never throws, for the same reason {@link readLedger} does not: an absent
 * table is the normal state of a database Bakery has not synced, and a row that
 * will not parse must not take a read-only command down. Unparseable rows are
 * skipped rather than nulled into the list, so a caller counting entries counts
 * usable ones.
 */
export async function readLedgerEntries(
  adapter: SQLAdapter,
): Promise<LedgerEntry[]> {
  try {
    const q = (s: string) => adapter.quote(s)
    const rows = (await adapter
      .query(
        `SELECT ${q('id')}, ${q('applied_at')}, ${q('payload')} ` +
          `FROM ${q(LEDGER_TABLE)} ORDER BY ${q('id')} DESC`,
      )
      .all()) as any[]
    const out: LedgerEntry[] = []
    for (const row of rows ?? []) {
      const payload = parsePayload(row?.payload)
      if (!payload) continue
      out.push({
        id: Number(row.id),
        appliedAt: Number(row.applied_at ?? row.appliedAt ?? 0),
        ...payload,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * The most recently applied schema, or `null` when there is none.
 *
 * Never throws: an unreadable or absent ledger is the normal state for a
 * database Bakery has not synced yet, and for one it has, a corrupt row must
 * degrade to introspection rather than take `db:sync` down.
 */
export async function readLedger(
  adapter: SQLAdapter,
): Promise<SyncTypes.DBConstraints | null> {
  const entries = await readLedgerEntries(adapter)
  return entries[0]?.constraints ?? null
}

/** Record what was just applied. Best-effort: a sync that worked still worked. */
export async function writeLedger(
  adapter: SQLAdapter,
  constraints: SyncTypes.DBConstraints,
  indexes: SyncTypes.DBIndexes = {},
): Promise<boolean> {
  try {
    await ensureTable(adapter)
    const q = (s: string) => adapter.quote(s)
    const payload = JSON.stringify({
      v: 2,
      constraints: stripLedger(constraints),
      indexes,
    })
    await adapter
      .query(
        `INSERT INTO ${q(LEDGER_TABLE)} (${q('applied_at')}, ${q('payload')}) VALUES (?, ?)`,
      )
      .run(Math.floor(Date.now() / 1000), payload)
    return true
  } catch {
    return false
  }
}

/**
 * Every spelling of the ledger's name that can appear in a constraints object.
 *
 * `getConstraints()` camelCases table names, so the table created as
 * `__bakery_schema` comes back as `bakerySchema` — matching only the literal
 * name silently stripped nothing, and the ledger showed up in its own diff as
 * a table the schema did not declare. Which then made the shape check fail
 * forever and the ledger never get used at all.
 */
const LEDGER_ALIASES = new Set([
  LEDGER_TABLE,
  Case.camel(LEDGER_TABLE),
  Case.snake(LEDGER_TABLE),
])

/** The ledger must never appear in a diff, or sync would try to manage itself. */
export function stripLedger(
  constraints: SyncTypes.DBConstraints,
): SyncTypes.DBConstraints {
  const hit = Object.keys(constraints).filter(k => LEDGER_ALIASES.has(k))
  if (!hit.length) return constraints
  const out = { ...constraints }
  for (const k of hit) delete (out as any)[k]
  return out
}

/**
 * Does the ledger still describe the same set of tables and columns as the
 * live database?
 *
 * **Names only, deliberately.** Comparing types or defaults here would need the
 * same normalisation the ledger exists to avoid, and a disagreement there is
 * exactly what the ledger is more trustworthy about. Names are names in every
 * dialect, so this check cannot itself be wrong in the way the others were.
 *
 * **But a name has two spellings, and the two sides do not use the same one.**
 * The ledger stores the keys of your TypeScript schema — whatever you passed to
 * `table()` / `view()` — while `getConstraints()` camelCases everything it reads
 * back. So a table declared `view('published_posts', …)` is `published_posts` in
 * the ledger and `publishedPosts` from introspection, and this check called that
 * a drifted database: *"tables differ (+publishedPosts; -published_posts)"*, on
 * a database nothing had touched. Permanently — the spellings never converge, so
 * every later sync re-reported it and the ledger was never used again. Every app
 * `bun create bakery` generated hit it on the first `db:sync`, because the
 * generated schema declares exactly that view.
 *
 * The damage is quieter than the warning. Falling back to introspection is
 * *safe*, so nothing breaks loudly — it just silently withdraws the thing the
 * ledger is for. Enum member changes, for one, only migrate when the diff runs
 * against the ledger (`plan.ledgerSource === 'ledger'`), so on any such app that
 * feature was inert.
 *
 * Comparing camel-normalised names fixes it at the one place the two spellings
 * meet. `LEDGER_ALIASES` below is the same bug, found earlier and patched for a
 * single known name; this is the general form of it.
 */
export function shapesMatch(
  ledger: SyncTypes.DBConstraints,
  live: SyncTypes.DBConstraints,
): { ok: true } | { ok: false; reason: string } {
  const meta = (k: string) => k.startsWith('_')
  // Compare on the normalised spelling, report the declared one — a diff that
  // named tables the reader cannot find in either their schema or their database
  // would trade one confusion for another.
  const namesOf = (o: object) => {
    const out = new Map<string, string>()
    for (const k of Object.keys(o ?? {})) {
      if (!meta(k)) out.set(Case.camel(k), k)
    }
    return out
  }
  const keysOf = (o: object) => [...namesOf(o).keys()].sort()

  const a = namesOf(ledger)
  const b = namesOf(live)
  if (keysOf(ledger).join() !== keysOf(live).join()) {
    const added = [...b].filter(([k]) => !a.has(k)).map(([, name]) => name)
    const gone = [...a].filter(([k]) => !b.has(k)).map(([, name]) => name)
    return {
      ok: false,
      reason: `tables differ (${added.length ? `+${added.join(', ')}` : ''}${
        added.length && gone.length ? '; ' : ''
      }${gone.length ? `-${gone.join(', ')}` : ''})`,
    }
  }

  for (const [key, name] of a) {
    const lc = keysOf((ledger as any)[name])
    const dc = keysOf((live as any)[b.get(key) as string])
    if (lc.join() !== dc.join()) {
      return { ok: false, reason: `columns of ${name} differ` }
    }
  }
  return { ok: true }
}

/**
 * Re-key a ledger payload the way introspection keys its own.
 *
 * The ledger stores the keys of your TypeScript schema verbatim; every consumer
 * of "current state" downstream looks tables up by `Case.camel(name)`, because
 * that is what `getConstraints()` produces. Handing the raw ledger to the
 * planner therefore made every lookup miss — `diffViews` asked for
 * `publishedPosts`, the ledger held `published_posts`, and a miss reads as "the
 * database does not have this view", so the view was recreated on every single
 * sync. Silent and harmless-looking; a view holds no data, so the only symptom
 * is churn in the log.
 *
 * Normalising on read rather than on write is deliberate: it repairs the ledgers
 * already written by earlier versions, which a write-side fix could not.
 *
 * Meta keys (`_view`, `_references`, …) are values, not identifiers, and are
 * copied through untouched.
 */
function normalizeLedgerKeys(
  constraints: SyncTypes.DBConstraints,
): SyncTypes.DBConstraints {
  const out: any = {}
  for (const [table, cols] of Object.entries(constraints)) {
    if (table.startsWith('_') || !cols || typeof cols !== 'object') {
      out[table] = cols
      continue
    }
    const next: any = {}
    for (const [col, def] of Object.entries(cols)) {
      next[col.startsWith('_') ? col : Case.camel(col)] = def
    }
    out[Case.camel(table)] = next
  }
  return out
}

/**
 * The state sync should diff against: the ledger when it is still true of the
 * database, introspection otherwise.
 *
 * Returning the *source* as well as the constraints is what lets the caller say
 * out loud which one it used — a sync that quietly changed its mind about where
 * truth lives would be very hard to debug later.
 */
export async function resolveCurrentState(
  adapter: SQLAdapter,
  options: { ignoreLedger?: boolean } = {},
): Promise<{
  constraints: SyncTypes.DBConstraints
  source: 'ledger' | 'introspection'
  reason?: string
}> {
  const live = stripLedger(await adapter.getConstraints())
  // `--no-ledger`, and it exists because the ledger can be *wrong about types*
  // in a way `shapesMatch` cannot see. That check compares names only, on
  // purpose — comparing types would need the dialect normalisation the ledger
  // exists to avoid — so a ledger claiming `VARCHAR(64)` where the column is
  // really `TEXT` matches its shape and wins the diff. That happens whenever a
  // sync legitimately concluded "no change needed" and the *rule* it used later
  // got stricter, which is exactly what adding width to the diff did.
  //
  // Without an escape hatch the only recovery is deleting the ledger table by
  // hand, and the symptom is `db:sync` insisting a database is perfectly synced
  // against a schema it does not match.
  if (options.ignoreLedger) {
    return {
      constraints: live,
      source: 'introspection',
      reason: 'ledger ignored (--no-ledger)',
    }
  }
  const raw = await readLedger(adapter)
  if (!raw)
    return {
      constraints: live,
      source: 'introspection',
      reason: 'no ledger yet',
    }

  const ledger = normalizeLedgerKeys(raw)
  const match = shapesMatch(ledger, live)
  if (!match.ok) {
    return { constraints: live, source: 'introspection', reason: match.reason }
  }
  return { constraints: ledger, source: 'ledger' }
}

/**
 * Has the database stopped matching what Bakery last applied?
 *
 * The same comparison {@link resolveCurrentState} makes, exposed on its own so
 * a caller can *report* it. Sync already handles drift correctly — it quietly
 * falls back to introspection — but quietly is the problem: a column added by
 * hand in production is indistinguishable, from the outside, from a normal run.
 * This is how you find out.
 *
 * `null` when there is nothing to say: no ledger yet (a database Bakery has not
 * synced is not "drifted"), or the shape still matches.
 *
 * Never throws. It runs at boot, and a database that cannot answer must not be
 * the reason a server fails to start — the sync path will raise anything that
 * genuinely matters.
 */
export async function detectDrift(
  adapter: SQLAdapter,
): Promise<{ reason: string } | null> {
  try {
    const ledger = await readLedger(adapter)
    if (!ledger) return null
    const live = stripLedger(await adapter.getConstraints())
    const match = shapesMatch(ledger, live)
    return match.ok ? null : { reason: match.reason }
  } catch {
    return null
  }
}
