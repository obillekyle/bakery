import { Bakery } from '@server/core/bakery'
import { Logger, messageLogger } from '@server/logger'
import { Try } from '@server/utils'

const MESSAGES = messageLogger(new Logger('db-backup'), {
  BACKUP_CREATED: 'I Created database backup: %y{file}%*',
  BACKUP_FAILED: 'E Failed to create database backup: %r{error}%*',
  BACKUP_CLEANUP: 'I Auto-deleted %c{count}%* old backup(s) to maintain limit.',
} as const)

export async function backupDatabase(adapter?: any) {
  const conn = adapter || (await import('./connection')).connection
  const [err, result] = await Try.catch(conn.backup(Bakery.config.backups))

  if (err) {
    MESSAGES.BACKUP_FAILED({ error: err.message })
    return
  }

  if (!result) {
    return
  }

  MESSAGES.BACKUP_CREATED({ file: result.file })
  if (result.cleanupCount && result.cleanupCount > 0) {
    MESSAGES.BACKUP_CLEANUP({ count: result.cleanupCount })
  }
}
