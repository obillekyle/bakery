import '@bakery/core/core/init'

import { Logger } from '@bakery/core/logger'
import type * as SyncTypes from './types'
import { type LedgerEntry, readLedgerEntries } from './ledger'

const logger = new Logger('db-history')

/**
 * What changed between two applied schemas, by name only.
 *
 * Names, not types — the same restraint `shapesMatch` uses and for the same
 * reason: a type comparison here would need dialect normalisation, which is the
 * thing the ledger exists to avoid depending on. A summary that says "column
 * changed" when a Postgres default merely re-rendered itself would be worse
 * than saying nothing.
 */
export interface HistoryDiff {
  tablesAdded: string[]
  tablesRemoved: string[]
  columnsAdded: string[]
  columnsRemoved: string[]
}

const meta = (k: string) => k.startsWith('_')
const namesOf = (o: unknown) => Object.keys(o ?? {}).filter(k => !meta(k))

export function diffEntries(
  older: SyncTypes.DBConstraints | null,
  newer: SyncTypes.DBConstraints,
): HistoryDiff {
  const out: HistoryDiff = {
    tablesAdded: [],
    tablesRemoved: [],
    columnsAdded: [],
    columnsRemoved: [],
  }
  const before = namesOf(older ?? {})
  const after = namesOf(newer)
  out.tablesAdded = after.filter(t => !before.includes(t))
  out.tablesRemoved = before.filter(t => !after.includes(t))

  // Only tables present in both: a column of a table that was added whole is
  // already accounted for by `tablesAdded`, and listing it again would make a
  // one-table migration read like dozens of changes.
  for (const table of after.filter(t => before.includes(t))) {
    const b = namesOf((older as any)?.[table])
    const a = namesOf((newer as any)[table])
    for (const c of a.filter(c => !b.includes(c)))
      out.columnsAdded.push(`${table}.${c}`)
    for (const c of b.filter(c => !a.includes(c)))
      out.columnsRemoved.push(`${table}.${c}`)
  }
  return out
}

export function isEmptyDiff(d: HistoryDiff): boolean {
  return (
    !d.tablesAdded.length &&
    !d.tablesRemoved.length &&
    !d.columnsAdded.length &&
    !d.columnsRemoved.length
  )
}

/** `applied_at` is stored as whole seconds — see `writeLedger`. */
export function formatWhen(appliedAt: number): string {
  if (!Number.isFinite(appliedAt) || appliedAt <= 0) return 'unknown'
  return new Date(appliedAt * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

export function formatEntry(
  entry: LedgerEntry,
  previous: LedgerEntry | undefined,
  isCurrent: boolean,
): string[] {
  const lines: string[] = []
  const marker = isCurrent ? ' (current)' : ''
  const tables = namesOf(entry.constraints).length
  lines.push(
    `  #${entry.id}  ${formatWhen(entry.appliedAt)} UTC  ${tables} table${
      tables === 1 ? '' : 's'
    }${marker}`,
  )

  const diff = diffEntries(previous?.constraints ?? null, entry.constraints)
  if (!previous) {
    lines.push('      initial schema')
  } else if (isEmptyDiff(diff)) {
    // Reachable and not a bug: a sync that only changed a column's *type* or an
    // index moves no names. Saying so is better than printing an empty block.
    lines.push('      no table or column names changed')
  } else {
    const show = (label: string, items: string[]) => {
      if (items.length) lines.push(`      ${label} ${items.join(', ')}`)
    }
    show('+ tables ', diff.tablesAdded)
    show('- tables ', diff.tablesRemoved)
    show('+ columns', diff.columnsAdded)
    show('- columns', diff.columnsRemoved)
  }
  // Only worth saying on rows that predate the payload carrying indexes,
  // because those are exactly the rows `db:rollback` will refuse.
  if (entry.indexes === undefined) {
    lines.push('      (no index record — written before ledger v2)')
  }
  return lines
}

export class HistoryService {
  protected constructor() {}

  static helpRequested(argv: string[] = process.argv.slice(2)): boolean {
    return argv.includes('--help') || argv.includes('-h')
  }

  static printHelp(): void {
    // Program output, not a log line — the same call the other commands' usage
    // text makes, and one of the two documented `console` exceptions.
    console.log(`
Usage: bun run db:history

Lists every schema Bakery has applied to this database, newest first, with
what changed between each one and the one before it.

Read-only. Nothing here writes to the database.
`)
  }

  static async run(): Promise<void> {
    if (HistoryService.helpRequested()) return HistoryService.printHelp()

    const { initConfig } = await import('@bakery/core/core/config')
    const { closeDB, connection, initDB } = await import('../connection')
    await initConfig()
    await initDB()

    const entries = await readLedgerEntries(connection)
    if (!entries.length) {
      // The level is `logger.log`'s second argument. A leading 'I ' is the
      // `messageLogger` table syntax and would be printed verbatim here.
      logger.log(
        'No schema history yet. The ledger fills up as %ydb:sync%* applies changes.',
        'info',
      )
      await closeDB()
      return
    }

    logger.log(
      `%g${entries.length}%* applied schema${entries.length === 1 ? '' : 's'}, newest first:`,
      'info',
    )
    // Newest first, and each row is compared against the row *after* it in the
    // list, which is the one that came before it in time.
    entries.forEach((entry, i) => {
      for (const line of formatEntry(entry, entries[i + 1], i === 0)) {
        logger.log(line, 'info')
      }
    })

    await closeDB()
  }
}

if (import.meta.main) {
  await HistoryService.run()
  process.exit(0)
}
