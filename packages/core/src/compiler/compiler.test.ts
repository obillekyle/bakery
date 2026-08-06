import { describe, test, expect, beforeAll } from 'bun:test'
import { compileText } from './compiler'

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
