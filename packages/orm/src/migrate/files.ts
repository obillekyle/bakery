import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A migration file: SQL, named for the order it runs in, run once.
 *
 * `0001_rooms.sql`, `0002_campus_check.sql`: a number, an underscore, a name.
 * Files run in the order of their numbers (so `9_x` comes before `10_y`), and
 * by name where two share a number, which is what two branches that each
 * added `0007_…` produce when they merge.
 */
export interface MigrationFile {
  /** The file name, which is also the file's key in the ledger. */
  name: string
  /** The number before the underscore, as a bigint so no prefix can overflow. */
  order: bigint
  path: string
  /** The text with a byte-order mark and CRLF line endings removed. */
  text: string
  /** SHA-256 of `text`, hex. What the ledger compares on every run. */
  checksum: string
  /**
   * False when the file's first line is `-- bakery:no-transaction`, for a
   * statement no transaction can hold (`CREATE INDEX CONCURRENTLY`). Such a
   * file may hold only that one statement.
   */
  transaction: boolean
}

/** `<digits>_<name>.sql`. */
const MIGRATION_NAME = /^(\d+)_[A-Za-z0-9._-]+\.sql$/

const NO_TRANSACTION = /^--\s*bakery:\s*no-transaction\s*$/i

export type ReadResult =
  | { ok: true; files: MigrationFile[] }
  | { ok: false; problems: string[] }

/**
 * Every migration in `dir`, in the order they run.
 *
 * A `.sql` file whose name does not fit is refused rather than skipped: a
 * misnamed migration that is silently ignored is a schema change that never
 * happens, discovered in production.
 */
export async function readMigrations(dir: string): Promise<ReadResult> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { ok: false, problems: [`${dir} does not exist.`] }
    }
    throw error
  }

  const problems: string[] = []
  const files: MigrationFile[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.sql')) continue
    const match = MIGRATION_NAME.exec(name)
    if (!match) {
      problems.push(
        `${name} is not named <number>_<name>.sql, so it has no place in the order.`,
      )
      continue
    }
    const path = join(dir, name)
    const text = normalize(await Bun.file(path).text())
    files.push({
      name,
      order: BigInt(match[1]!),
      path,
      text,
      checksum: checksumOf(text),
      transaction: !NO_TRANSACTION.test(firstLine(text)),
    })
  }

  if (problems.length) return { ok: false, problems }
  files.sort(compareMigrations)
  return { ok: true, files }
}

/** Run order: by number, then by name. */
export function compareMigrations(
  a: Pick<MigrationFile, 'order' | 'name'>,
  b: Pick<MigrationFile, 'order' | 'name'>,
): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * The text the checksum is taken over. A byte-order mark and CRLF line endings
 * are an editor's or a checkout's, not the migration's: a repository cloned on
 * Windows with `core.autocrlf` must not make every applied file look edited.
 */
export function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

export function checksumOf(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex')
}

function firstLine(text: string): string {
  const trimmed = text.trimStart()
  const end = trimmed.indexOf('\n')
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim()
}
