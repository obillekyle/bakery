/**
 * CSV, RFC 4180-ish, with the delimiter sniffed rather than assumed.
 *
 * **Pure** — see the note at the top of `coerce.ts`. The client parses the file
 * the user dropped and the server re-parses whatever it is sent, and they have
 * to agree, so there is one parser.
 *
 * ## Why not `parseCSVRows` from `orm/adapters/base.ts:1071`
 *
 * It was read first, and reusing it was the intent. Four things stop it, and
 * the first two are correctness rather than taste:
 *
 * 1. **A quote anywhere opens a quoted field.** `he said "hi", ok` parses as
 *    one field `he said hi, ok` rather than two, because the branch is
 *    `if (c === '"') inQuotes = true` with no check that the field is empty.
 *    RFC 4180 only gives `"` meaning at the start of a field.
 * 2. **No BOM handling.** A file saved by Excel begins `﻿`, so the first
 *    header comes back as `﻿id` and matches no column — the single most
 *    common import failure there is.
 * 3. Comma only. A European export is `;`-delimited and a database dump is
 *    often tab-delimited; both parse as one column per row and then fail with
 *    a message about the header.
 * 4. It returns `string[][]` with a blank final row dropped by a heuristic
 *    (`row.length === 1 && row[0] === ''`), which also drops a legitimate
 *    single-column row whose value is empty.
 *
 * Fixing it in place would change `importCSV`'s behaviour for every existing
 * caller of the ORM, which is a separate decision from adding an importer to
 * the explorer. This parser is the explorer's; if the ORM's is ever replaced,
 * this is the implementation to move.
 */

/** The delimiters `sniffDelimiter` will consider, in preference order. */
export const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const

export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number]

export interface CSVTable {
  headers: string[]
  rows: string[][]
  delimiter: string
  /**
   * Rows whose field count differs from the header count, as
   * `{row, fields}` — 1-based over the data rows, so it lines up with what a
   * spreadsheet shows. Ragged rows are still returned in `rows`, padded with
   * `''` or truncated; refusing the whole file for one short line is not the
   * importer's call to make.
   */
  ragged: { row: number; fields: number }[]
}

/** Strip a UTF-8 BOM. Excel writes one; nothing downstream expects it. */
export function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Which delimiter this file uses.
 *
 * Counts occurrences **outside quotes** in the first few lines and takes the
 * candidate whose count is both non-zero and most consistent line to line. A
 * naive `indexOf` count picks `,` for a `;`-delimited file the moment one
 * quoted address contains a comma, which is the common case rather than an
 * exotic one.
 */
export function sniffDelimiter(text: string): Delimiter {
  const sample = stripBOM(text)
  let best: Delimiter = ','
  let bestScore = -1

  for (const candidate of CANDIDATE_DELIMITERS) {
    const counts = countPerLine(sample, candidate, 20)
    if (!counts.length || counts[0] === 0) continue
    // Consistency first, frequency second: a delimiter that appears the same
    // number of times on every line is a delimiter; one that appears a varying
    // number of times is text.
    const consistent = counts.every(n => n === counts[0])
    const score = (consistent ? 1000 : 0) + counts[0]!
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/** Occurrences of `delimiter` per line, outside quotes, for the first `max` lines. */
function countPerLine(text: string, delimiter: string, max: number): number[] {
  const counts: number[] = []
  let inQuotes = false
  let count = 0
  let atFieldStart = true

  for (let i = 0; i < text.length && counts.length < max; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') i++
      else if (c === '"') inQuotes = false
      continue
    }
    if (c === '"' && atFieldStart) {
      inQuotes = true
      atFieldStart = false
    } else if (c === delimiter) {
      count++
      atFieldStart = true
    } else if (c === '\n') {
      counts.push(count)
      count = 0
      atFieldStart = true
    } else if (c !== '\r') {
      atFieldStart = false
    }
  }
  if (count > 0 || counts.length === 0) counts.push(count)
  return counts
}

/**
 * Rows of fields, with nothing interpreted.
 *
 * No trimming and no type guessing: `"01"` and `01` are both the three-, then
 * two-character strings they look like, and turning either into a number is
 * `coerce.ts`'s job once a column is known. A field is only ever `''` when the
 * file said so — this parser has no concept of NULL.
 */
export function parseCSVRows(text: string, delimiter = ','): string[][] {
  const csv = stripBOM(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let atFieldStart = true
  /** Did any field of the current row open with a quote? */
  let rowQuoted = false
  /** Has anything at all been read since the last row ended? */
  let pending = false

  const endField = () => {
    row.push(field)
    field = ''
    atFieldStart = true
    pending = true
  }

  const endRow = () => {
    endField()
    // A blank line is not a row: it is what a trailing newline, or a stray one
    // in the middle of a file, leaves behind. One field, empty, and never
    // quoted is the only shape it can take — a line reading `""` is a real row
    // holding one empty value, which is why `rowQuoted` is tracked.
    const blank = row.length === 1 && row[0] === '' && !rowQuoted
    if (!blank) rows.push(row)
    row = []
    rowQuoted = false
    pending = false
  }

  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (inQuotes) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        inQuotes = false
      } else {
        // Includes newlines: a quoted field spans lines, which is the reason
        // a line-splitting "parser" cannot be used for CSV at all.
        field += c
      }
      continue
    }

    if (c === '"' && atFieldStart) {
      inQuotes = true
      rowQuoted = true
      atFieldStart = false
      pending = true
    } else if (c === delimiter) {
      endField()
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && csv[i + 1] === '\n') i++
      endRow()
    } else {
      field += c
      atFieldStart = false
      pending = true
    }
  }

  // Anything still buffered is a final row with no line terminator.
  if (pending) endRow()

  return rows
}

/**
 * A whole file: headers, data rows squared off against them, and what the
 * delimiter turned out to be.
 */
export function parseCSV(
  text: string,
  options: { delimiter?: string } = {},
): CSVTable {
  const delimiter = options.delimiter ?? sniffDelimiter(text)
  const all = parseCSVRows(text, delimiter)
  if (!all.length) return { headers: [], rows: [], delimiter, ragged: [] }

  // Headers are the one place trimming is right: a header is a name, and
  // `" id "` naming the column `id` is what every spreadsheet means by it.
  const headers = all[0]!.map(h => h.trim())
  const ragged: { row: number; fields: number }[] = []
  const rows = all.slice(1).map((fields, index) => {
    if (fields.length !== headers.length) {
      ragged.push({ row: index + 1, fields: fields.length })
    }
    const squared = fields.slice(0, headers.length)
    while (squared.length < headers.length) squared.push('')
    return squared
  })

  return { headers, rows, delimiter, ragged }
}

/** A parsed table as records, keyed by header. */
export function csvRecords(table: CSVTable): Record<string, string>[] {
  return table.rows.map(fields => {
    const record: Record<string, string> = {}
    for (let i = 0; i < table.headers.length; i++) {
      record[table.headers[i]!] = fields[i] ?? ''
    }
    return record
  })
}
