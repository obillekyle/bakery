/**
 * Just enough of a SQL lexer to read a migration file's statements without
 * running them: where each one starts, what its first words are, and how many
 * there are.
 *
 * It exists for two refusals. A migration runs inside the runner's own
 * transaction, so a `COMMIT` in the file would commit part of it and leave the
 * rest, and its ledger row, outside (measured on Postgres: the table created
 * before a `COMMIT` survived the rollback of a later failure). And a file that
 * opts out of the transaction must hold one statement, because a failure
 * halfway through anything longer cannot be undone.
 *
 * The file itself goes to the driver as written. Splitting it here and sending
 * the pieces would mean trusting this scanner with every construct a dialect
 * has; reading it only to refuse means a construct it misreads costs a false
 * refusal, never a corrupted migration.
 */

export type ScriptDialect = 'pgsql' | 'sqlite' | 'mysql'

export interface ScriptStatement {
  /** The statement's first one or two words, upper-cased: `COMMIT`, `START TRANSACTION`. */
  head: string
  /** 1-based line the statement starts on, for messages. */
  line: number
}

/** Words that open a statement which ends or opens a transaction. */
const TRANSACTION_CONTROL = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
  'START TRANSACTION',
  'PREPARE TRANSACTION',
])

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y
const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y

/**
 * The statements in `text`, in order.
 *
 * Handles what a migration actually contains: `--` and `/* *\/` comments
 * (nested on Postgres), single-quoted strings with doubled quotes and the
 * `E'…'` backslash form, double-quoted and backticked identifiers, Postgres
 * dollar-quoted bodies (`$$ … $$`, `$fn$ … $fn$`), and the `BEGIN … END` body
 * of a trigger, which holds semicolons that do not end the statement.
 */
export function scanStatements(
  text: string,
  dialect: ScriptDialect,
): ScriptStatement[] {
  const statements: ScriptStatement[] = []
  let line = 1
  let i = 0

  // The statement being read: its first words, and how deep it is inside a
  // BEGIN … END body (above 0 once a CREATE statement's BEGIN is seen).
  let words: string[] = []
  let startLine = 0
  let bodyDepth = 0

  const finish = () => {
    if (words.length) {
      statements.push({ head: headOf(words), line: startLine })
    }
    words = []
    bodyDepth = 0
  }

  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) line++
    i = to
  }

  while (i < text.length) {
    const ch = text[i]!

    if (
      (ch === '-' && text[i + 1] === '-') ||
      (ch === '#' && dialect === 'mysql')
    ) {
      const end = text.indexOf('\n', i)
      advance(end === -1 ? text.length : end)
      continue
    }

    if (ch === '/' && text[i + 1] === '*') {
      advance(blockCommentEnd(text, i, dialect === 'pgsql'))
      continue
    }

    if (/\s/.test(ch)) {
      advance(i + 1)
      continue
    }

    if (ch === ';') {
      advance(i + 1)
      if (bodyDepth === 0) finish()
      continue
    }

    if (!words.length) startLine = line

    if (ch === "'" || ((ch === 'E' || ch === 'e') && text[i + 1] === "'")) {
      const backslashes = ch !== "'" || dialect === 'mysql'
      const open = ch === "'" ? i : i + 1
      advance(quotedEnd(text, open, "'", backslashes))
      words.push('')
      continue
    }

    if (ch === '"' || (ch === '`' && dialect === 'mysql')) {
      advance(quotedEnd(text, i, ch, false))
      words.push('')
      continue
    }

    if (ch === '$' && dialect === 'pgsql') {
      DOLLAR_TAG.lastIndex = i
      const tag = DOLLAR_TAG.exec(text)
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length)
        advance(close === -1 ? text.length : close + tag[0].length)
        words.push('')
        continue
      }
    }

    WORD.lastIndex = i
    const word = WORD.exec(text)
    if (word) {
      const upper = word[0].toUpperCase()
      advance(i + word[0].length)
      if (words.length < 8) words.push(upper)

      // A BEGIN inside a CREATE statement opens a body with statements of its
      // own: a SQLite trigger's, a Postgres `BEGIN ATOMIC` function's. A CASE
      // inside the body has an END of its own. A CREATE statement never holds
      // a transaction's BEGIN, so a plain `BEGIN;` still reads as one.
      if (words[0] === 'CREATE' && words.length > 1) {
        if (upper === 'BEGIN' || (upper === 'CASE' && bodyDepth > 0)) {
          bodyDepth++
        } else if (upper === 'END' && bodyDepth > 0) {
          bodyDepth--
        }
      }
      continue
    }

    advance(i + 1)
    if (words.length < 8) words.push(ch)
  }

  finish()
  return statements
}

/** The statements in `text` that would end or open a transaction. */
export function transactionControl(
  text: string,
  dialect: ScriptDialect,
): ScriptStatement[] {
  return scanStatements(text, dialect).filter(s =>
    TRANSACTION_CONTROL.has(s.head),
  )
}

function headOf(words: string[]): string {
  const [first = '', second = ''] = words
  if ((first === 'START' || first === 'PREPARE') && second === 'TRANSACTION') {
    return `${first} TRANSACTION`
  }
  return first
}

/** Index just past the comment opening at `start`. */
function blockCommentEnd(text: string, start: number, nests: boolean): number {
  let depth = 0
  let i = start
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      depth++
      i += 2
      if (!nests && depth > 1) depth = 1
      continue
    }
    if (text[i] === '*' && text[i + 1] === '/') {
      depth--
      i += 2
      if (depth === 0) return i
      continue
    }
    i++
  }
  return text.length
}

/** Index just past the quoted run opening at `start`. */
function quotedEnd(
  text: string,
  start: number,
  quote: string,
  backslashes: boolean,
): number {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (backslashes && ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) {
      if (text[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return text.length
}
