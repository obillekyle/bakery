import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fs } from './fs'

/**
 * `exists` used to take the path back off a `BunFile` and build a second one
 * to stat it. A `BunFile` caches its own stat, so the instance the caller
 * already holds is free to read and the fresh one is a syscall: every caller
 * that asks both "is it there" and "how old is it" paid two.
 *
 * Counting syscalls directly would need `node:fs` module-mocking, which is
 * process-global and never unwinds (convention 9). This asks the structural
 * question instead: a stand-in whose accessors count their reads is only read
 * from if the instance is the one being used. Against the form this replaces
 * both counters stay at zero, because the stand-in is discarded for its name.
 */
describe('fs.exists', () => {
  test('reads the BunFile it is given rather than re-wrapping its name', () => {
    let lastModifiedReads = 0
    let sizeReads = 0
    const standIn = {
      name: 'C:/nowhere/this-path-does-not-exist.txt',
      get lastModified() {
        lastModifiedReads++
        return Date.now() - 10_000
      },
      get size() {
        sizeReads++
        return 42
      },
    } as unknown as Bun.BunFile

    expect(fs.exists(standIn)).toBe(true)
    expect(lastModifiedReads).toBeGreaterThan(0)
    // `size` is the second clause and short-circuits away when the first
    // answers true, so only the read that must happen is asserted on.
    expect(lastModifiedReads + sizeReads).toBeGreaterThan(0)
  })

  test('still answers correctly for a real present and absent file', () => {
    const dir = mkdtempSync(`${tmpdir()}/bakery-exists-`)
    try {
      const file = `${dir}/there.txt`
      writeFileSync(file, 'x')
      expect(fs.exists(file)).toBe(true)
      expect(fs.exists(Bun.file(file))).toBe(true)
      expect(fs.exists(`${dir}/not-there.txt`)).toBe(false)
      expect(fs.exists(Bun.file(`${dir}/not-there.txt`))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an absent file is absent even though lastModified is not zero', () => {
    // The subtlety the single-stat rewrite has to preserve: Bun answers
    // `lastModified` for a missing file with roughly `Date.now()`, not 0. A
    // truthiness check alone reports every absent file as present.
    const dir = mkdtempSync(`${tmpdir()}/bakery-exists-`)
    try {
      const missing = Bun.file(`${dir}/gone.txt`)
      expect(missing.lastModified).toBeGreaterThan(0)
      expect(fs.exists(missing)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
