import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Bakery } from './core/bakery'

/**
 * Session cookies are signed: `sId=<id>.<mac>`, an HMAC-SHA256 of the id.
 *
 * The id alone is the bearer token, and it is unguessable, so the signature
 * adds nothing to whether a stolen cookie works. What it buys is a refusal
 * that costs nothing: with `sessions.store`, every request carrying a
 * well-formed id used to cost a lookup by primary key before the rate limiter
 * could refuse it (`Session.attach` runs first, since `keyBy` may read the
 * session), so a flood of made-up ids from one address queued on the pool
 * behind real traffic. A made-up id now fails here, in microseconds, and no
 * store is asked. The built-in store gains the same, for its SQLite tier.
 *
 * The stored id is unchanged: only the cookie carries the MAC, so no store
 * row or column moves.
 */

/** Bytes of the MAC a cookie carries: 128 bits, ample for a MAC. */
const MAC_BYTES = 16

/** The key made for this process from `bakery/session.key`, once read. */
let keptKey: Buffer | null = null

/**
 * The key that signs: `sessions.secret` when set, else the one kept in the
 * data directory, made on first use. Every worker on the machine reads the
 * same file, and the first to make it wins (`wx`), so they agree. Servers
 * sharing one store need the same `sessions.secret`.
 */
function signingKey(secret: string | undefined): Buffer | string {
  if (secret) return secret
  keptKey ??= keyFromFile(`${Bakery.dataDir}/session.key`)
  return keptKey
}

function keyFromFile(path: string): Buffer {
  const read = () => Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url')
  try {
    return read()
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }

  // Absent: make it. A worker that loses the race to create it reads the
  // winner's instead, so every worker signs with the same key.
  mkdirSync(Bakery.dataDir, { recursive: true })
  const key = randomBytes(32)
  try {
    writeFileSync(path, key.toString('base64url'), { flag: 'wx', mode: 0o600 })
    return key
  } catch (error: any) {
    if (error?.code === 'EEXIST') return read()
    throw new Error(
      `Session cookies are signed with a key kept in ${path}, which could not be written (${error?.message ?? error}). Set sessions.secret in server.config.ts instead.`,
    )
  }
}

function mac(key: Buffer | string, id: string): Buffer {
  return createHmac('sha256', key).update(id).digest().subarray(0, MAC_BYTES)
}

/** The cookie value for a session id: the id, a dot, and its MAC. */
export function signSessionId(id: string, secret?: string): string {
  return `${id}.${mac(signingKey(secret), id).toString('base64url')}`
}

/**
 * The session id a cookie value names, or `''` when its MAC does not match
 * (or it has none, as a cookie issued before signing has none): such a
 * cookie names no session, and nothing is looked up for it. Compared in
 * constant time, so the comparison says nothing about how close a guess came.
 */
export function verifiedSessionId(value: string, secret?: string): string {
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return ''
  const id = value.slice(0, dot)
  const given = Buffer.from(value.slice(dot + 1), 'base64url')
  const expected = mac(signingKey(secret), id)
  if (given.length !== expected.length) return ''
  return timingSafeEqual(given, expected) ? id : ''
}

/** Test seam: forget the kept key, so the next use reads the file again. */
export function __forgetSessionKey(): void {
  keptKey = null
}
