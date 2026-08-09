import { beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { fs } from '../utils/fs'
import { compile, compileText } from './compiler'

describe('compileText', () => {
  test('transforms TypeScript to JavaScript', async () => {
    const result = await compileText('const x: number = 42')
    expect(result).toContain('42')
    expect(result).not.toContain(': number')
  })

  test('handles plain JavaScript input', async () => {
    const result = await compileText('const x = 42')
    expect(result).toContain('42')
  })

  test('handles empty input', async () => {
    const result = await compileText('')
    expect(typeof result).toBe('string')
  })

  test('preserves JSX-like syntax', async () => {
    const input = 'const count = 42'
    const result = await compileText(input)
    expect(result).toContain('42')
  })
})

/**
 * A compile failure has to survive the trip back to the handler.
 *
 * The pathless branch has always caught the transpiler and logged
 * `COMPILE_SOURCE_FAIL`; the branch *with* a path — the one every `.ts` asset
 * request takes — did not, so the throw escaped `compile()` and unwound past
 * `TSHandler` into the worker's catch-all. The developer got
 * `Unhandled Server Error: Expected identifier but found end of file`: no file,
 * no line, and a body of `An unexpected error occurred.` Meanwhile
 * `TSHandler`'s own `'Compilation Failed'` 500 could never fire, because
 * nothing ever returned to it.
 */
const BROKEN_ROOT = fs.resolve(process.cwd(), '.cache/__compiler-test__')

describe('compileText — a failure with a path in hand', () => {
  test('returns null instead of throwing past the caller', async () => {
    const path = fs.resolve(BROKEN_ROOT, 'broken.ts') as fs.AbsolutePath

    // Not `expect(...).rejects` — the point is that it resolves.
    const result = await compileText('export default function ( {', path)
    expect(result).toBeNull()
  })

  test('a source string with no path still resolves', async () => {
    // Unchanged behaviour, pinned so the two branches cannot diverge again:
    // pathless compiles return the original source.
    const result = await compileText('export default function ( {')
    expect(result).toBe('export default function ( {')
  })

  test('compile() of a broken file resolves null rather than throwing', async () => {
    const path = fs.resolve(BROKEN_ROOT, 'page.ts') as fs.AbsolutePath
    await Bun.write(path, 'export const broken: number =\n')

    try {
      expect(await compile(path)).toBeNull()
    } finally {
      await rm(BROKEN_ROOT, { recursive: true, force: true })
    }
  })
})
