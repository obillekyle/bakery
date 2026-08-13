import { describe, expect, test } from 'bun:test'
import {
  autoThreadCount,
  FALLBACK_THREADS,
  MAX_AUTO_THREADS,
  parseThreadsOption,
} from './args'

/**
 * `parseThreadsOption` decides whether the process forks a cluster at all, and
 * with how many workers. It lived inside `index.ts`, which cannot be imported
 * by a test — the file dispatches on the mode flags and boots a server.
 *
 * The argv slice is passed in rather than read, so none of this touches
 * `process.argv`.
 */
describe('parseThreadsOption', () => {
  test('absent means no cluster, and that is not the same as one worker', () => {
    // `index.ts` branches on `threadsOption !== null`, so returning 1 here
    // instead of null would route every plain `bun run serve` through
    // `handleThreadsMaster` — a master process, a Worker, and on Windows a
    // loopback relay serve, for a server that asked for none of it.
    expect(parseThreadsOption([])).toBeNull()
    expect(parseThreadsOption(['--dev', '--sync'])).toBeNull()
  })

  test('reads the count from either spelling', () => {
    expect(parseThreadsOption(['--threads', '4'])).toBe(4)
    expect(parseThreadsOption(['-t', '4'])).toBe(4)
    expect(parseThreadsOption(['--threads=4'])).toBe(4)
    expect(parseThreadsOption(['-t=4'])).toBe(4)
  })

  test('finds the flag after other arguments', () => {
    expect(parseThreadsOption(['--sync', '--port', '8080', '-t', '3'])).toBe(3)
  })

  test('a cluster never has zero workers', () => {
    // `0` passes the digit test, so without the Math.max the master would
    // spawn no Workers and serve nothing — on Linux, where there is no relay
    // serve, that is a process listening on nothing.
    expect(parseThreadsOption(['--threads', '0'])).toBe(1)
    expect(parseThreadsOption(['--threads=0'])).toBe(1)
  })

  test('a non-numeric or absent value falls back to the auto count', () => {
    // Not an error: `--threads --dev` and `--threads` as the last argument are
    // both "cluster, you pick". A rejection here would make the flag's
    // valueless form unusable.
    const auto = autoThreadCount()
    expect(parseThreadsOption(['--threads'])).toBe(auto)
    expect(parseThreadsOption(['--threads', '--dev'])).toBe(auto)
    expect(parseThreadsOption(['--threads', 'many'])).toBe(auto)
    expect(parseThreadsOption(['--threads=', '4'])).toBe(auto)
    expect(parseThreadsOption(['--threads=many'])).toBe(auto)
  })

  test('a negative or fractional value is not read as a count', () => {
    // `/^\d+$/` rejects both, so they take the auto path rather than reaching
    // `parseInt` — which would have turned `-2` into 1 and `2.9` into 2.
    const auto = autoThreadCount()
    expect(parseThreadsOption(['--threads', '-2'])).toBe(auto)
    expect(parseThreadsOption(['--threads', '2.9'])).toBe(auto)
  })

  test('the value is not itself mistaken for a flag on the next pass', () => {
    // The loop does not skip the consumed value, so `--threads` followed by
    // something starting with `-t=` would be a genuine hazard. Pinning that
    // the first match wins.
    expect(parseThreadsOption(['--threads', '2', '-t=6'])).toBe(2)
  })

  test('the first flag wins when both spellings appear', () => {
    expect(parseThreadsOption(['-t=6', '--threads', '2'])).toBe(6)
  })
})

describe('autoThreadCount', () => {
  test('is clamped to a usable range', () => {
    // The cap is the point: an uncapped `navigator.hardwareConcurrency` on a
    // large CI runner forks that many servers onto one accept queue.
    const n = autoThreadCount()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(MAX_AUTO_THREADS)
    expect(Number.isInteger(n)).toBe(true)
  })

  test('the fallback is inside the range it feeds', () => {
    // If `navigator.hardwareConcurrency` is 0 or undefined the fallback is the
    // answer, so a fallback above the cap would silently be the cap instead.
    expect(FALLBACK_THREADS).toBeGreaterThanOrEqual(1)
    expect(FALLBACK_THREADS).toBeLessThanOrEqual(MAX_AUTO_THREADS)
  })
})
