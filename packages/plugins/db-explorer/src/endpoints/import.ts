/**
 * CSV import — the rows, not the file.
 *
 * The parse happens in the browser, in `shared/csv.ts`, and stays there. This
 * endpoint takes rows that are already records, so the mapping the user
 * confirmed in the dialog is what arrives, rather than a file the server
 * re-guesses the columns of. No CSV text reaches the server at all.
 *
 * Two things separate it from `POST /api/_db/rows`, and both are about scale:
 * the bound is a spreadsheet's worth of rows rather than an edit's, and a bad
 * row does not have to end the whole import — `onBadRow: 'skip'` reports it and
 * carries on, which is what a 50,000-row file with three malformed lines needs.
 */

import { Try } from '@bakery-framework/core/utils'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import { DB } from '@bakery-framework/orm/orm'
import { overLimit } from '../policy'
import { isRollbackSignal, previewRollback } from '../preview'
import { type FieldError, validateInsertRow } from '../validate'
import { beginWrite, invalid } from './common'

export type OnBadRow = 'stop' | 'skip'

export async function handleImport(
  req: Request,
): Promise<JsonResponseData<unknown>> {
  const start = await beginWrite(req)
  if (!start.ok) return start.response
  const { table, body } = start

  const rows = body.rows
  if (!Array.isArray(rows) || !rows.length) {
    return response.json.error(400, 'rows must be a non-empty array')
  }
  const over = overLimit('csvRows', rows.length)
  if (over) return response.json.error(413, over)

  const onBadRow: OnBadRow = body.onBadRow === 'skip' ? 'skip' : 'stop'
  if (body.onBadRow !== 'skip' && body.onBadRow !== 'stop') {
    // Named explicitly rather than defaulted silently: the two answers differ
    // in whether a partially-good file gets partially imported, which is the
    // one decision the caller must have made on purpose.
    return response.json.error(400, "onBadRow must be 'stop' or 'skip'")
  }

  const errors: FieldError[] = []
  const records: Record<string, unknown>[] = []
  rows.forEach((row, index) => {
    const validated = validateInsertRow(row, table, index)
    if (validated.errors.length) {
      errors.push(...validated.errors)
      return
    }
    records.push(validated.values)
  })

  // `stop` refuses the whole file before a statement runs — the same "413 with
  // nothing executed" promise, for a 400.
  if (onBadRow === 'stop' && errors.length) return invalid(errors)

  const skipped = rows.length - records.length
  if (!records.length) {
    return response.json.success('imported', { inserted: 0, skipped, errors })
  }

  const dryRun = body.dryRun === true

  return await Try.return(
    async () =>
      await DB.transaction(async () => {
        const result = await DB.Insert.into(table.name).values(records).run()
        const report = {
          inserted: Number(result.changes ?? 0),
          skipped,
          errors,
        }
        if (dryRun) previewRollback(report)
        return response.json.success('imported', report)
      }),
    (error: any) => {
      if (isRollbackSignal(error)) {
        return response.json.success(error.message, error.report, error.status)
      }
      return response.json.error(400, error?.message ?? 'Import failed')
    },
  )
}
