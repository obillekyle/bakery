import { describe, expect, test } from 'bun:test'
import { scanStatements, transactionControl } from './script'

const heads = (text: string, dialect: 'pgsql' | 'sqlite' | 'mysql' = 'pgsql') =>
  scanStatements(text, dialect).map(s => s.head)

describe('scanStatements', () => {
  test('splits on top-level semicolons and reports where each starts', () => {
    const text =
      'CREATE TABLE a (id int);\n\nALTER TABLE a ADD b int;\nDROP TABLE c'
    expect(scanStatements(text, 'pgsql')).toEqual([
      { head: 'CREATE', line: 1 },
      { head: 'ALTER', line: 3 },
      { head: 'DROP', line: 4 },
    ])
  })

  test('a semicolon in a string, an identifier or a comment ends nothing', () => {
    const text = [
      "INSERT INTO t VALUES ('a;b', 'it''s; fine');",
      'CREATE TABLE "odd;name" (x int); -- trailing; comment',
      '/* a; block; comment */ SELECT 1;',
    ].join('\n')
    expect(heads(text)).toEqual(['INSERT', 'CREATE', 'SELECT'])
  })

  test('a Postgres function body in dollar quotes is one statement', () => {
    const text = `
      CREATE FUNCTION bump() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER t BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION bump();
    `
    expect(heads(text)).toEqual(['CREATE', 'CREATE'])
  })

  test('a tagged dollar quote may hold $$', () => {
    const text =
      "CREATE FUNCTION f() RETURNS text AS $fn$ SELECT '$$;' $fn$ LANGUAGE sql; COMMIT;"
    expect(heads(text)).toEqual(['CREATE', 'COMMIT'])
  })

  test('a SQLite trigger body is one statement, CASE inside it included', () => {
    const text = `
      CREATE TRIGGER audit AFTER UPDATE ON rooms
      BEGIN
        INSERT INTO log VALUES (CASE WHEN NEW.x > 0 THEN 'up' ELSE 'down' END);
        UPDATE rooms SET touched = 1 WHERE id = NEW.id;
      END;
      SELECT 1;
    `
    expect(heads(text, 'sqlite')).toEqual(['CREATE', 'SELECT'])
  })

  test('a Postgres BEGIN ATOMIC body is one statement', () => {
    const text =
      'CREATE FUNCTION one() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END; SELECT 2;'
    expect(heads(text)).toEqual(['CREATE', 'SELECT'])
  })

  test('E strings take backslash escapes; plain strings do not on Postgres', () => {
    expect(heads("SELECT E'it\\'s;'; SELECT 'a\\'; SELECT 2;")).toEqual([
      'SELECT',
      'SELECT',
      'SELECT',
    ])
  })

  test('block comments nest on Postgres', () => {
    expect(heads('/* outer /* inner; */ still comment; */ SELECT 1;')).toEqual([
      'SELECT',
    ])
  })

  test('MySQL takes # comments and backticked identifiers', () => {
    expect(
      heads('# note; here\nCREATE TABLE `a;b` (x int); SELECT 1;', 'mysql'),
    ).toEqual(['CREATE', 'SELECT'])
  })

  test('empty statements and a file of comments are nothing', () => {
    expect(heads(';;\n-- only a comment\n/* and this */')).toEqual([])
  })
})

describe('transactionControl', () => {
  test('finds what would commit part of a migration', () => {
    const text = [
      'BEGIN;',
      'CREATE TABLE a (id int);',
      'COMMIT;',
      'START TRANSACTION;',
      'SAVEPOINT s;',
      'ROLLBACK;',
      'END;',
    ].join('\n')
    expect(transactionControl(text, 'pgsql')).toEqual([
      { head: 'BEGIN', line: 1 },
      { head: 'COMMIT', line: 3 },
      { head: 'START TRANSACTION', line: 4 },
      { head: 'SAVEPOINT', line: 5 },
      { head: 'ROLLBACK', line: 6 },
      { head: 'END', line: 7 },
    ])
  })

  test('the words inside bodies, strings and identifiers are not statements', () => {
    const text = `
      CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN COMMIT; END; $$ LANGUAGE plpgsql;
      INSERT INTO notes VALUES ('COMMIT; please');
      CREATE TABLE "commit" (x int);
    `
    expect(transactionControl(text, 'pgsql')).toEqual([])
  })

  test("a SQLite trigger body's END is not a commit", () => {
    const text =
      'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1; END;'
    expect(transactionControl(text, 'sqlite')).toEqual([])
  })
})
