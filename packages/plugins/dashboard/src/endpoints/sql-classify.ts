/**
 * Decide whether a statement only reads.
 *
 * The gate this feeds is `DASHBOARD_ALLOW_WRITES`, and it used to be a prefix
 * test on the raw string:
 *
 * ```ts no-check — the bug, kept for the reader
 * const isSelect = /^(select|with|show|describe|pragma|explain)/.test(sqlLower)
 * ```
 *
 * `WITH x AS (SELECT 1) DELETE FROM users` starts with `with`, so it classified
 * as a read and **executed with writes disabled**. So did
 * `PRAGMA writable_schema = ON`, which is the first half of editing the schema
 * table by hand. The gate was decorative against anyone who knew either.
 *
 * Two rules replace it, and both point the same way — *unrecognised is a
 * write*. The old code failed open: anything it did not understand fell into
 * the read branch and ran. Convention 2 says an indeterminate answer is a
 * denial, and a write gate is exactly the place to mean it.
 *
 * This does not attempt to be a SQL parser, and it does not need to be. It is
 * a gate: it may refuse a read it does not recognise, and the cost of that is
 * an error message. It may never admit a write.
 */

/** Anything that can change data, schema, session state or the filesystem. */
const WRITE_KEYWORDS = new Set([
  'insert',
  'update',
  'delete',
  'replace',
  'merge',
  'upsert',
  'truncate',
  'drop',
  'create',
  'alter',
  'rename',
  'grant',
  'revoke',
  'attach',
  'detach',
  'vacuum',
  'reindex',
  'analyze',
  'copy',
  'load',
  'call',
  'do',
  'execute',
  'prepare',
  'deallocate',
  'set',
  'reset',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'lock',
  'unlock',
  'import',
  'restore',
  'backup',
  'shutdown',
  'kill',
])

/** Statements permitted to lead a read. */
const READ_LEADERS = new Set([
  'select',
  'with',
  'show',
  'describe',
  'desc',
  'explain',
  'values',
  'table',
  'pragma',
])

/**
 * The four things `stripNoise` removes, one function each.
 *
 * Each skipper is handed the index **at** the construct's opening and returns
 * the index just **past** its close, or `null` if it is not that construct.
 * One function per construct rather than one loop with four inline bodies: the
 * dispatch then has a branch per construct and no nesting, which is what keeps
 * it under biome's complexity limit as cases are added.
 *
 * All four run to end-of-input rather than giving up on an unterminated
 * construct. Leaving the tail unscanned is how text hidden after an unclosed
 * quote would reach the keyword pass.
 */

/** `-- …` to end of line. */
function skipLineComment(sql: string, i: number): number | null {
  if (sql.slice(i, i + 2) !== '--') return null
  const end = sql.indexOf('\n', i)
  return end === -1 ? sql.length : end
}

/** `/* … *\/`, counting depth — Postgres nests these. */
function skipBlockComment(sql: string, i: number): number | null {
  if (sql.slice(i, i + 2) !== '/*') return null

  let depth = 1
  let at = i + 2
  while (at < sql.length && depth > 0) {
    const two = sql.slice(at, at + 2)
    if (two === '/*') {
      depth++
      at += 2
    } else if (two === '*/') {
      depth--
      at += 2
    } else {
      at++
    }
  }
  return at
}

/** A `'`, `"` or backtick literal, honouring `\x` and a doubled quote. */
function skipQuoted(sql: string, i: number): number | null {
  const quote = sql[i]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null

  let at = i + 1
  while (at < sql.length) {
    if (sql[at] === '\\') {
      at += 2
      continue
    }
    if (sql[at] === quote) {
      // A doubled quote is an escaped one, not the end of the literal.
      if (sql[at + 1] === quote) {
        at += 2
        continue
      }
      return at + 1
    }
    at++
  }
  return sql.length
}

/** Postgres `$$ … $$` / `$tag$ … $tag$`. */
function skipDollarQuoted(sql: string, i: number): number | null {
  if (sql[i] !== '$') return null
  const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
  if (!tag) return null

  const close = sql.indexOf(tag[0], i + tag[0].length)
  return close === -1 ? sql.length : close + tag[0].length
}

const SKIPPERS = [
  skipLineComment,
  skipBlockComment,
  skipQuoted,
  skipDollarQuoted,
]

/**
 * Remove comments and quoted text, leaving only syntax.
 *
 * Everything downstream matches keywords, so a `--` comment or a string
 * literal containing the word `delete` must not reach it — and, the other way
 * round, `VACUUM/*x*\/INTO 'evil.db'` must not hide a keyword *behind* a
 * comment. The old denylist matched `vacuum\s+into` against raw text and
 * missed exactly that, because `\s+` does not span a comment.
 */
export function stripNoise(sql: string): string {
  let out = ''
  let i = 0

  while (i < sql.length) {
    let skipped: number | null = null
    for (const skip of SKIPPERS) {
      skipped = skip(sql, i)
      if (skipped !== null) break
    }

    if (skipped === null) {
      out += sql[i]
      i++
      continue
    }

    // A space, never nothing: `SELECT/**\/1` must not collapse into the single
    // token `select1`, and `a--x\nb` must not become `ab`.
    out += ' '
    i = skipped
  }

  return out
}

/** Statements in `sql`, ignoring empty ones. Quoted `;` is already gone. */
export function splitStatements(stripped: string): string[] {
  return stripped
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
}

export interface Classification {
  readOnly: boolean
  /** Why it was refused. Absent when `readOnly`. */
  reason?: string
}

/**
 * `readOnly: false` means "run this only when writes are enabled". It does not
 * promise the statement is valid SQL — that is the database's job.
 */
export function classifyStatement(sql: string): Classification {
  const stripped = stripNoise(sql)
  const statements = splitStatements(stripped)

  if (statements.length === 0) return { readOnly: false, reason: 'empty' }

  // One statement per request. Multi-statement text is where `SELECT 1;
  // DROP TABLE users` lives, and nothing in the console needs a batch.
  if (statements.length > 1) {
    return { readOnly: false, reason: 'multiple statements in one request' }
  }

  const statement = statements[0] ?? ''
  // Annotated: `?? []` on its own infers `never[]`, which makes the
  // `includes('analyze')` below an error rather than a check.
  const tokens: string[] =
    statement.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []

  const head = tokens[0]
  if (!head) return { readOnly: false, reason: 'no statement' }

  if (!READ_LEADERS.has(head)) {
    return { readOnly: false, reason: `${head.toUpperCase()} is a write` }
  }

  // A write keyword **anywhere**, at any nesting depth — not merely at the top
  // level. Postgres data-modifying CTEs put the write inside the parentheses:
  // `WITH x AS (INSERT INTO t … RETURNING *) SELECT * FROM x` writes, and a
  // depth-aware check that only looked at the outer statement would wave it
  // through.
  //
  // Tokenisation is what keeps this from being noisy: `delete_count`,
  // `updates` and `insert_log` are single tokens and match nothing. Literals
  // and quoted identifiers are already stripped, so a column called "delete"
  // is invisible here too.
  const offender = tokens.find(t => WRITE_KEYWORDS.has(t))
  if (offender) {
    return {
      readOnly: false,
      reason: `${offender.toUpperCase()} is a write`,
    }
  }

  // `PRAGMA table_info(users)` reads; `PRAGMA writable_schema = ON` does not.
  // The assignment form is the whole difference, and `writable_schema` is the
  // documented way to edit sqlite_master by hand.
  if (head === 'pragma' && statement.includes('=')) {
    return { readOnly: false, reason: 'PRAGMA assignment is a write' }
  }

  // `EXPLAIN ANALYZE` **executes** the statement on Postgres rather than
  // planning it. `analyze` is in WRITE_KEYWORDS so this is already refused
  // above; the check stays as the explicit statement of intent, because the
  // reason someone would remove `analyze` from that set is not knowing this.
  if (head === 'explain' && tokens.includes('analyze')) {
    return { readOnly: false, reason: 'EXPLAIN ANALYZE executes the statement' }
  }

  return { readOnly: true }
}
