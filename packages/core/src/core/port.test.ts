import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_PORT, resolvePort } from './port'
import { fs } from '../utils/fs'

/**
 * Port resolution used to be written three times with three different rules,
 * and the two that mattered most disagreed in the worst possible direction:
 * `worker.ts` (`Number`) bound the port, `startup.ts` (`parseInt`) printed it.
 * `PORT=3000x` therefore handed `Bun.serve` a `NaN`, which Bun silently turns
 * into an ephemeral port, under a banner reading `http://localhost:3000/`.
 *
 * These tests pin the single rule, and then pin that all three call sites
 * still go through it.
 */

const original = Object.getOwnPropertyDescriptor(process.env, 'PORT')

function setPort(value: string | undefined) {
  if (value === undefined) delete (process.env as any).PORT
  else process.env.PORT = value
}

afterEach(() => {
  if (original) Object.defineProperty(process.env, 'PORT', original)
  else delete (process.env as any).PORT
})

describe('resolvePort', () => {
  test('unset PORT falls through to the config port', () => {
    setPort(undefined)
    expect(resolvePort(8080)).toBe(8080)
  })

  test('unset PORT and no config port is the documented default', () => {
    setPort(undefined)
    expect(resolvePort()).toBe(DEFAULT_PORT)
    expect(DEFAULT_PORT).toBe(3000)
  })

  test('an empty PORT counts as unset, not as 0', () => {
    setPort('')
    expect(resolvePort(8080)).toBe(8080)
    setPort('   ')
    expect(resolvePort(8080)).toBe(8080)
  })

  test('a valid PORT wins over the config port', () => {
    setPort('8080')
    expect(resolvePort(3000)).toBe(8080)
  })

  test('surrounding whitespace is tolerated', () => {
    setPort(' 8080 ')
    expect(resolvePort(3000)).toBe(8080)
  })

  test('PORT=0 is honoured — it means "let the OS pick"', () => {
    setPort('0')
    expect(resolvePort(3000)).toBe(0)
  })

  test.each(['3000x', 'abc', '-1', '70000', '3000.5', '0x1f', 'Infinity'])(
    'PORT=%p is refused loudly rather than guessed at',
    bad => {
      setPort(bad)
      expect(() => resolvePort(3000)).toThrow(/Invalid PORT/)
      // The message has to be actionable at 3am: it names the variable and
      // quotes the value that was rejected.
      expect(() => resolvePort(3000)).toThrow(JSON.stringify(bad))
    },
  )

  test('a config port of 0 still means "unset"', () => {
    setPort(undefined)
    expect(resolvePort(0)).toBe(DEFAULT_PORT)
  })
})

/**
 * The behaviour above is only worth anything if the three processes that need
 * to agree actually ask this function. Each of them used to spell the rule out
 * itself; this fails the moment one of them starts again.
 */
describe('the three port call sites share one rule', () => {
  const repo = fs.resolve(import.meta.dir, '..', '..', '..', '..')

  const CALL_SITES = [
    'packages/core/src/startup.ts',
    'packages/core/src/compiler/dev-service.ts',
    'packages/cli/src/worker.ts',
  ]

  test.each(CALL_SITES)('%s resolves the port through resolvePort', async rel => {
    const source = await Bun.file(fs.resolve(repo, rel)).text()
    expect(source).toContain('resolvePort(')
  })

  test.each(CALL_SITES)('%s does not read process.env.PORT itself', async rel => {
    const source = await Bun.file(fs.resolve(repo, rel)).text()
    // Comments are allowed to mention `PORT`; code reading it is not.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    expect(code).not.toContain('process.env.PORT')
  })
})
