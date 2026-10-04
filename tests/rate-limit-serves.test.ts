import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type AppServer, bootApp } from './support/serve-app'

/**
 * The rate limiter, asked through a server booted in production.
 *
 * The limiter runs inside `worker.ts`'s `Bun.serve` callback, which no unit
 * test can import (it binds a port at module scope), so the pieces are tested
 * in `pipeline.test.ts` and `rate-limit.test.ts` and the joints are tested
 * here: the handler recorded during routing, the token borrowed and given
 * back, a URL proven and later forgotten, a rule's own bucket.
 *
 * The app is written to a temporary directory: a config with numbers small
 * enough to exhaust in a few requests would be the wrong config for either of
 * the repo's apps. Every test sends its own `x-test-client`, which `keyBy`
 * turns into its own bucket, so no test spends another's budget.
 */
const PORT = 4602
const CLI = resolve(import.meta.dir, '../packages/cli/src/index.ts')

const CONFIG = `const client = (req: Request) => req.headers.get('x-test-client') ?? ''

export default {
  root: 'src',
  rateLimit: {
    max: 3,
    refill: 0.5,
    keyBy: client,
    routes: [{ prefix: '/api/auth', max: 2, refill: 0.5, keyBy: client }],
  },
}
`

let dir = ''
let server: AppServer | null = null

function writeApp(at: string, config: string): void {
  writeFileSync(join(at, 'server.config.ts'), config)
  writeFileSync(
    join(at, 'src/index.html'),
    '<!doctype html><html><head><title>limits</title></head><body><h1>limits</h1></body></html>\n',
  )
  writeFileSync(join(at, 'src/app.css'), 'body { color: rebeccapurple }\n')
  writeFileSync(join(at, 'src/gone.txt'), 'here for now\n')
  writeFileSync(join(at, 'src/client.ts'), 'export const answer: number = 42\n')
  writeFileSync(
    join(at, 'src/api/ping.ts'),
    'export default () => ({ pong: true })\n',
  )
  writeFileSync(
    join(at, 'src/api/auth/sign-in.ts'),
    'export default () => ({ signedIn: false })\n',
  )
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bakery-rate-limit-'))
  await mkdir(join(dir, 'src/api/auth'), { recursive: true })
  writeApp(dir, CONFIG)
  server = await bootApp(dir, PORT)
}, 90_000)

afterAll(() => {
  server?.stop()
  // On Windows the killed server still holds its database for a moment.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

async function get(client: string, path: string): Promise<Response> {
  const res = await fetch(server!.base + path, {
    headers: { 'x-test-client': client },
  })
  await res.arrayBuffer()
  return res
}

async function statuses(client: string, path: string, times: number) {
  const out: number[] = []
  for (let i = 0; i < times; i++) out.push((await get(client, path)).status)
  return out
}

describe('the rate limiter, served', () => {
  test('an asset served once stops counting, a page does not', async () => {
    // A bucket of 3. The stylesheet and the module are asked for 8 times
    // each, which spent 16 tokens before assets stopped counting, and the
    // bucket still has all 3 for pages afterwards.
    expect(await statuses('assets', '/app.css', 8)).toEqual(Array(8).fill(200))
    expect(await statuses('assets', '/client.js', 8)).toEqual(
      Array(8).fill(200),
    )
    expect(await statuses('assets', '/', 4)).toEqual([200, 200, 200, 429])
  })

  test('a path that is not there keeps counting', async () => {
    // The static handler is the fallback for every path, and the route cache
    // remembers it for made-up ones too. What keeps this flood limited is
    // that a 404 never proves an asset.
    expect(await statuses('made-up', '/nope.css', 5)).toEqual([
      404, 404, 404, 429, 429,
    ])
  })

  test('a route rule spends from its own bucket', async () => {
    expect(await statuses('rule', '/api/auth/sign-in', 3)).toEqual([
      200, 200, 429,
    ])
    // Refused with the rule's refill in mind: 0.5 a second is 2 s a token.
    const refused = await get('rule', '/api/auth/sign-in')
    expect(refused.headers.get('retry-after')).toBe('2')
    // The top level is a different bucket, untouched by the rule's.
    expect((await get('rule', '/api/ping')).status).toBe(200)
  })

  test('every spelling routing accepts is charged to the rule', async () => {
    // Measured on this tree: `/api//auth/sign-in` reaches the sign-in route
    // (routing drops empty segments), and on Windows so does
    // `/API/AUTH/sign-in` (the filesystem ignores case). A prefix compared as
    // a raw string would have handed both the top level's budget.
    expect((await get('spellings', '/api/auth/sign-in')).status).toBe(200)
    expect((await get('spellings', '/api//auth/sign-in')).status).toBe(200)
    expect((await get('spellings', '/API/AUTH/sign-in')).status).toBe(429)
  })

  test('a deleted asset is free once more, then counted', async () => {
    expect((await get('gone', '/gone.txt')).status).toBe(200)
    await rm(join(dir, 'src/gone.txt'))
    // The first request after the delete skipped the bucket on the old proof,
    // so it is charged after the fact; from then on every 404 is charged up
    // front like any other.
    expect(await statuses('gone', '/gone.txt', 4)).toEqual([404, 404, 404, 429])
  })
})

describe('a rate limit that cannot mean anything', () => {
  test('stops the boot, naming the field', async () => {
    const bad = mkdtempSync(join(tmpdir(), 'bakery-rate-limit-bad-'))
    try {
      await mkdir(join(bad, 'src/api/auth'), { recursive: true })
      writeApp(
        bad,
        `export default {
  root: 'src',
  rateLimit: { max: 10, refill: 1, routes: [{ prefix: 'api/auth', max: 2, refill: 1 }] },
}
`,
      )
      const proc = Bun.spawn(['bun', CLI], {
        cwd: bad,
        env: { ...process.env, PORT: String(PORT + 1) },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => proc.kill(), 60_000)
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      clearTimeout(timer)

      expect(code).toBe(1)
      expect(out + err).toContain(
        'rateLimit.routes[0].prefix must be a path starting with "/"',
      )
    } finally {
      rmSync(bad, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      })
    }
  }, 90_000)
})
