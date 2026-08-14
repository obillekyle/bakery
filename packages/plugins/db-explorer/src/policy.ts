/**
 * How much one request may do.
 *
 * These are not rate limits and not tuning knobs — they are the size at which a
 * request stops being an edit and starts being a migration. The explorer has no
 * raw-SQL endpoint precisely so that nothing it exposes can rewrite a table in
 * one call; a `rows` array with no ceiling would put that back, one row at a
 * time.
 *
 * **Over a bound is a 413 with nothing executed.** Not a truncation, and not a
 * partial apply: a caller who sent 5,000 rows and got "1,000 inserted" has no
 * way to know which 1,000, and the retry duplicates them.
 *
 * The numbers are deliberately round rather than derived. The one real
 * constraint — the ~32,766 bound parameters a statement may carry — is already
 * handled below this layer, by `DB.Insert`'s batching.
 */

export const LIMITS = {
  /** Rows in one `POST /api/_db/rows`. */
  insertRows: 1000,
  /** Edits in one `POST /api/_db/rows/bulk`. */
  bulkEdits: 1000,
  /** Keys in one `DELETE /api/_db/rows`. */
  deleteKeys: 1000,
  /** Rows in one `POST /api/_db/import` — a spreadsheet, not an edit. */
  csvRows: 50_000,
  /** Foreign-key targets resolved in one `POST /api/_db/lookup`. */
  lookupRefs: 200,
} as const

export type LimitName = keyof typeof LIMITS

/**
 * The 413 message for a request that is too big, or `null` if it fits.
 *
 * Returns the rejection rather than throwing, and returns it for an
 * indeterminate count as well (a `keys` that is not an array reads as `NaN`) —
 * convention 2's shape, applied to a bound rather than to an identity.
 */
export function overLimit(limit: LimitName, count: number): string | null {
  const max = LIMITS[limit]
  if (Number.isFinite(count) && count <= max) return null
  return `too many: ${limit} is limited to ${max} per request, got ${count}`
}
