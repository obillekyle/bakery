import { Case } from '@bakery/core/utils'
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
  const id = adapter.colDef({ type: 'integer', autoIncrement: true, primary: true })
  const at = adapter.colDef({ type: 'integer' })
  const payload = adapter.colDef({ type: 'string' })
  await adapter
    .query(
      `CREATE TABLE IF NOT EXISTS ${q(LEDGER_TABLE)} (` +
        `${q('id')} ${id}, ${q('applied_at')} ${at}, ${q('payload')} ${payload})`,
    )
    .run()
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
  try {
    const q = (s: string) => adapter.quote(s)
    const rows = (await adapter
      .query(
        `SELECT ${q('payload')} FROM ${q(LEDGER_TABLE)} ORDER BY ${q('id')} DESC`,
      )
      .all()) as any[]
    const raw = rows?.[0]?.payload
    if (typeof raw !== 'string') return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    // No table yet, or a row we cannot parse. Both mean "no usable ledger".
    return null
  }
}

/** Record what was just applied. Best-effort: a sync that worked still worked. */
export async function writeLedger(
  adapter: SQLAdapter,
  constraints: SyncTypes.DBConstraints,
): Promise<boolean> {
  try {
    await ensureTable(adapter)
    const q = (s: string) => adapter.quote(s)
    await adapter
      .query(
        `INSERT INTO ${q(LEDGER_TABLE)} (${q('applied_at')}, ${q('payload')}) VALUES (?, ?)`,
      )
      .run(Math.floor(Date.now() / 1000), JSON.stringify(stripLedger(constraints)))
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
 */
export function shapesMatch(
  ledger: SyncTypes.DBConstraints,
  live: SyncTypes.DBConstraints,
): { ok: true } | { ok: false; reason: string } {
  const meta = (k: string) => k.startsWith('_')
  const tablesOf = (c: SyncTypes.DBConstraints) =>
    Object.keys(c).filter(t => !meta(t)).sort()
  const colsOf = (t: any) => Object.keys(t ?? {}).filter(c => !meta(c)).sort()

  const a = tablesOf(ledger)
  const b = tablesOf(live)
  if (a.join() !== b.join()) {
    const added = b.filter(t => !a.includes(t))
    const gone = a.filter(t => !b.includes(t))
    return {
      ok: false,
      reason: `tables differ (${added.length ? `+${added.join(', ')}` : ''}${
        added.length && gone.length ? '; ' : ''
      }${gone.length ? `-${gone.join(', ')}` : ''})`,
    }
  }

  for (const t of a) {
    const lc = colsOf((ledger as any)[t])
    const dc = colsOf((live as any)[t])
    if (lc.join() !== dc.join()) {
      return { ok: false, reason: `columns of ${t} differ` }
    }
  }
  return { ok: true }
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
): Promise<{
  constraints: SyncTypes.DBConstraints
  source: 'ledger' | 'introspection'
  reason?: string
}> {
  const live = stripLedger(await adapter.getConstraints())
  const ledger = await readLedger(adapter)
  if (!ledger) return { constraints: live, source: 'introspection', reason: 'no ledger yet' }

  const match = shapesMatch(ledger, live)
  if (!match.ok) {
    return { constraints: live, source: 'introspection', reason: match.reason }
  }
  return { constraints: ledger, source: 'ledger' }
}
