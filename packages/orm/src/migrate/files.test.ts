import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checksumOf, normalize, readMigrations } from './files'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bakery-migrations-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text)
  }
  return dir
}

describe('readMigrations', () => {
  test('files run in the order of their numbers, then their names', async () => {
    const dir = folder({
      '10_later.sql': 'SELECT 10;',
      '9_earlier.sql': 'SELECT 9;',
      '0007_b.sql': 'SELECT 7;',
      '0007_a.sql': 'SELECT 7;',
    })
    const read = await readMigrations(dir)
    if (!read.ok) throw new Error(read.problems.join('\n'))
    // A plain string sort would put 10 before 9.
    expect(read.files.map(f => f.name)).toEqual([
      '0007_a.sql',
      '0007_b.sql',
      '9_earlier.sql',
      '10_later.sql',
    ])
  })

  test('a .sql file without a number is refused, not skipped', async () => {
    // Skipped, it would be a schema change that never happens.
    const dir = folder({
      '0001_ok.sql': 'SELECT 1;',
      'rooms.sql': 'SELECT 2;',
      '0002-dash.sql': 'SELECT 3;',
    })
    const read = await readMigrations(dir)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems.length).toBe(2)
    expect(read.problems.join('\n')).toContain(
      'rooms.sql is not named <number>_<name>.sql',
    )
  })

  test('anything that is not .sql is left alone', async () => {
    const dir = folder({ '0001_a.sql': 'SELECT 1;', 'README.md': '# notes' })
    const read = await readMigrations(dir)
    expect(read.ok && read.files.length).toBe(1)
  })

  test('a folder that is not there is a problem, not a crash', async () => {
    const read = await readMigrations(join(tmpdir(), `nope-${process.pid}-x`))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problems[0]).toContain('does not exist')
  })

  test('a byte-order mark and CRLF line endings do not change the checksum', async () => {
    // A checkout with core.autocrlf, or an editor that writes a BOM, must not
    // make an applied file look edited.
    const lf = 'CREATE TABLE a (id int);\nSELECT 1;\n'
    expect(checksumOf(normalize(`\uFEFF${lf.replace(/\n/g, '\r\n')}`))).toBe(
      checksumOf(normalize(lf)),
    )
    const dir = folder({ '0001_a.sql': `\uFEFF${lf.replace(/\n/g, '\r\n')}` })
    const read = await readMigrations(dir)
    if (!read.ok) throw new Error(read.problems.join('\n'))
    expect(read.files[0]!.text).toBe(lf)
  })

  test('a first line of -- bakery:no-transaction opts the file out', async () => {
    const dir = folder({
      '0001_a.sql':
        '-- bakery:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (x);',
      '0002_b.sql': '  --Bakery: No-Transaction  \nSELECT 1;',
      '0003_c.sql': 'SELECT 1;\n-- bakery:no-transaction',
    })
    const read = await readMigrations(dir)
    if (!read.ok) throw new Error(read.problems.join('\n'))
    expect(read.files.map(f => f.transaction)).toEqual([false, false, true])
  })
})
