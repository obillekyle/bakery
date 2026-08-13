import { describe, expect, test } from 'bun:test'
import { classifyStatement, splitStatements, stripNoise } from './sql-classify'

const readOnly = (sql: string) => classifyStatement(sql).readOnly

describe('the bypasses this replaced', () => {
  /**
   * Each of these was classified as a read by the prefix test that used to
   * guard `DASHBOARD_ALLOW_WRITES`, and therefore ran with writes disabled.
   * They are the reason the classifier exists, so they come first.
   */
  test('a CTE does not launder a DELETE', () => {
    expect(readOnly('WITH x AS (SELECT 1) DELETE FROM users')).toBe(false)
    expect(readOnly('with t as (select 1) update users set name = 1')).toBe(
      false,
    )
    expect(readOnly('WITH a AS (SELECT 1) DROP TABLE users')).toBe(false)
  })

  test('a data-modifying CTE is a write even though the write is nested', () => {
    // Postgres runs this. The INSERT is inside parentheses, so a check that
    // only looked at the top level would admit it.
    expect(
      readOnly(
        'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x',
      ),
    ).toBe(false)
  })

  test('PRAGMA writable_schema is a write', () => {
    expect(readOnly('PRAGMA writable_schema = ON')).toBe(false)
    expect(readOnly('pragma writable_schema=1')).toBe(false)
    // …while the introspection form stays usable.
    expect(readOnly('PRAGMA table_info(users)')).toBe(true)
  })

  test('a comment cannot hide VACUUM INTO', () => {
    // The old denylist was /\b(attach|detach|vacuum\s+into)\b/i over raw text,
    // and `\s+` does not span a comment.
    expect(readOnly("VACUUM/*x*/INTO 'C:/evil.db'")).toBe(false)
    expect(readOnly("SELECT 1; ATTACH DATABASE 'evil.db' AS e")).toBe(false)
  })

  test('a second statement cannot ride along', () => {
    expect(readOnly('SELECT 1; DROP TABLE users')).toBe(false)
    expect(readOnly('SELECT 1;\n-- comment\nDELETE FROM users')).toBe(false)
  })

  test('EXPLAIN ANALYZE executes on Postgres, so it is a write', () => {
    expect(readOnly('EXPLAIN ANALYZE SELECT * FROM users')).toBe(false)
    expect(readOnly('EXPLAIN SELECT * FROM users')).toBe(true)
  })

  test('SELECT … FOR UPDATE takes locks', () => {
    expect(readOnly('SELECT * FROM users FOR UPDATE')).toBe(false)
  })
})

describe('ordinary reads still run', () => {
  test.each([
    'SELECT * FROM users',
    '  select 1  ',
    'SELECT * FROM users WHERE name = ?',
    'WITH recent AS (SELECT * FROM logs) SELECT * FROM recent',
    'SHOW TABLES',
    'DESCRIBE users',
    'EXPLAIN SELECT 1',
    'SELECT COUNT(*) FROM orders',
    'SELECT * FROM users; ',
    'SELECT 1 -- trailing comment',
    'SELECT * FROM information_schema.columns',
  ])('%s', sql => {
    expect(readOnly(sql)).toBe(true)
  })

  test('an identifier that merely contains a keyword is not a write', () => {
    // Tokenisation, not substring matching. These read as writes under any
    // `includes()`-shaped check, and they are perfectly ordinary column names.
    expect(readOnly('SELECT delete_count FROM stats')).toBe(true)
    expect(readOnly('SELECT * FROM updates')).toBe(true)
    expect(readOnly('SELECT * FROM insert_log WHERE dropped_at IS NULL')).toBe(
      true,
    )
    expect(readOnly('SELECT created_at, deleted_at FROM users')).toBe(true)
  })

  test('a keyword inside a string literal is not a write', () => {
    expect(readOnly("SELECT * FROM t WHERE note = 'please delete me'")).toBe(
      true,
    )
    expect(readOnly("SELECT 'drop table users' AS spooky")).toBe(true)
  })
})

describe('unrecognised is a write', () => {
  test.each([
    '',
    '   ',
    ';;',
    '-- just a comment',
    '/* nothing */',
  ])('%p is refused rather than admitted', sql => {
    expect(readOnly(sql)).toBe(false)
  })

  test('an unknown leading keyword is refused', () => {
    // The old classifier fell through to the read branch for anything it did
    // not recognise. This one names it and refuses.
    expect(classifyStatement('MERGE INTO t USING s ON (1=1)')).toEqual({
      readOnly: false,
      reason: 'MERGE is a write',
    })
    expect(classifyStatement('FLUSH PRIVILEGES').readOnly).toBe(false)
  })
})

describe('stripNoise', () => {
  test('removes line and block comments, leaving a separator', () => {
    // A space, not nothing: `SELECT/**/1` must not become the token `select1`.
    expect(stripNoise('SELECT/**/1').includes('select1')).toBe(false)
    expect(stripNoise('a--x\nb').replace(/\s+/g, '')).toBe('ab')
  })

  test('counts nested block comments, as Postgres does', () => {
    expect(stripNoise('SELECT /* a /* b */ c */ 1').includes('c')).toBe(false)
  })

  test('a doubled quote does not end the literal early', () => {
    expect(stripNoise("SELECT 'it''s fine' FROM t").includes('fine')).toBe(
      false,
    )
  })

  test('strips dollar-quoted bodies', () => {
    expect(stripNoise('SELECT $$ drop table t $$').includes('drop')).toBe(false)
    expect(stripNoise('SELECT $tag$ delete $tag$').includes('delete')).toBe(
      false,
    )
  })

  test('an unterminated literal swallows the rest rather than leaking it', () => {
    // What follows an unclosed quote is treated as part of the literal, so
    // nothing hidden after it reaches the keyword scan. This *does* classify as
    // a read — and that is safe, not a gap: the statement is unterminated SQL,
    // so the database rejects it before anything happens. The property being
    // pinned is that the scanner stays inside the literal to the end of input
    // rather than resynchronising and running the tail as code.
    expect(readOnly("SELECT 'unterminated DROP TABLE users")).toBe(true)
    expect(stripNoise("SELECT 'x DROP").includes('drop')).toBe(false)
  })
})

describe('splitStatements', () => {
  test('drops empties and trims', () => {
    expect(splitStatements(' SELECT 1 ;; SELECT 2 ; ')).toEqual([
      'SELECT 1',
      'SELECT 2',
    ])
  })

  test('a semicolon inside a literal has already been stripped', () => {
    expect(splitStatements(stripNoise("SELECT 'a;b'"))).toHaveLength(1)
  })
})
