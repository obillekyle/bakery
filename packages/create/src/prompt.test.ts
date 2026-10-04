import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The prompts, driven the way a person drives them: one after another on one
 * stdin, each answered once its question is on screen.
 *
 * The state machines are tested in `index.test.ts` without a terminal, and
 * this is the part they could not see. In 2.1.1 every prompt read stdin with
 * `for await`, and leaving that loop destroyed the stream, so the second
 * prompt of every interactive run (the plugins, after the ORM question) died
 * with `AbortError: The operation was aborted`. A pipe stands in for the
 * terminal: raw mode is skipped where there is no TTY, and the reads are the
 * same.
 */
const PROMPT = join(import.meta.dir, 'prompt.ts')
const dir = mkdtempSync(join(tmpdir(), 'create-bakery-prompts-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SCRIPT = `
import { confirm, multiselect } from ${JSON.stringify(PROMPT)}
const orm = await confirm('Include the ORM?', true)
const plugins = await multiselect('Plugins', [
  { id: 'vue', label: 'vue' },
  { id: 'analytics', label: 'analytics' },
])
const install = await confirm('Install now?', true)
console.log('RESULT ' + JSON.stringify({ orm, plugins, install }))
`

let runs = 0

/**
 * Run the three prompts, sending each step's keys once its marker is on
 * screen, and return what they answered. A step's keys of `null` closes stdin
 * instead.
 */
async function drive(steps: [marker: string, keys: string | null][]) {
  const file = join(dir, `run-${runs++}.ts`)
  writeFileSync(file, SCRIPT)
  const proc = Bun.spawn(['bun', file], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  const until = async (marker: string) => {
    while (!seen.includes(marker)) {
      const { value, done } = await reader.read()
      if (done) {
        const err = await new Response(proc.stderr).text()
        throw new Error(`exited before "${marker}"\n${seen}\n${err}`)
      }
      seen += decoder.decode(value)
    }
  }

  for (const [marker, keys] of steps) {
    await until(marker)
    if (keys === null) proc.stdin.end()
    else {
      proc.stdin.write(keys)
      proc.stdin.flush()
    }
  }
  await until('RESULT ')
  expect(await proc.exited).toBe(0)
  return JSON.parse(seen.slice(seen.indexOf('RESULT ') + 7).split('\n')[0]!)
}

describe('three prompts on one stdin', () => {
  test('each one answers, the second included', async () => {
    expect(
      await drive([
        ['Include the ORM?', 'n'],
        ['Plugins', ' \r'],
        ['Install now?', 'n'],
      ]),
    ).toEqual({ orm: false, plugins: ['vue'], install: false })
  }, 20_000)

  test('a canceled prompt leaves stdin to the next one', async () => {
    expect(
      await drive([
        ['Include the ORM?', 'y'],
        ['Plugins', '\x03'],
        ['Install now?', '\r'],
      ]),
    ).toEqual({ orm: true, plugins: null, install: true })
  }, 20_000)

  test('stdin closing mid-question cancels it rather than hanging', async () => {
    expect(
      await drive([
        ['Include the ORM?', '\r'],
        ['Plugins', '\r'],
        ['Install now?', null],
      ]),
    ).toEqual({ orm: true, plugins: [], install: null })
  }, 20_000)
})
