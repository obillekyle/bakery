import { Bakery } from '@bakery/core/core/bakery'
import { Logger, messageLogger } from '@bakery/core/logger'
import { Try } from '@bakery/core/utils'

const MESSAGES = messageLogger(new Logger('db-backup'), {
  BACKUP_CREATED: 'I Created database backup: %y{file}%*',
  BACKUP_FAILED: 'E Failed to create database backup: %r{error}%*',
  BACKUP_SKIPPED: 'W No database backup was produced (in-memory DB or no dump tool available).',
  BACKUP_CLEANUP: 'I Auto-deleted %c{count}%* old backup(s) to maintain limit.',
} as const)

/**
 * Returns whether a backup file was actually written. Callers about to run a
 * destructive migration must check this — a thrown error, a `:memory:` database,
 * or a missing `pg_dump`/`mysqldump` all previously looked identical to success.
 */
export async function backupDatabase(adapter?: any): Promise<boolean> {
  const conn = adapter || (await import('./connection')).connection
  const [err, result] = await Try.catch(conn.backup(Bakery.config.backups))

  if (err) {
    MESSAGES.BACKUP_FAILED({ error: err.message })
    return false
  }

  if (!result) {
    MESSAGES.BACKUP_SKIPPED()
    return false
  }

  MESSAGES.BACKUP_CREATED({ file: result.file })
  if (result.cleanupCount && result.cleanupCount > 0) {
    MESSAGES.BACKUP_CLEANUP({ count: result.cleanupCount })
  }
  return true
}
