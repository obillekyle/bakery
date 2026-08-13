/**
 * Command-line argument parsing for the `bakery` bin.
 *
 * Split out of `index.ts` so it can be tested: that file is the mode
 * dispatcher, and importing it boots a server. Nothing here reads
 * `process.argv` — the caller passes the slice, which is also what lets a test
 * state the argv it means.
 */

/** Upper bound on the auto-detected worker count. */
export const MAX_AUTO_THREADS = 8

/** Fallback when `navigator.hardwareConcurrency` is unavailable. */
export const FALLBACK_THREADS = 4

/**
 * Worker count for a bare `--threads` / `-t`, with no number after it.
 *
 * Capped rather than uncapped: past ~8 the workers contend on the same
 * loopback accept queue and the shared pool's atomics, and a 64-core CI box
 * forking 64 servers is not what the flag means.
 */
export function autoThreadCount(): number {
  return Math.min(
    Math.max(1, navigator.hardwareConcurrency || FALLBACK_THREADS),
    MAX_AUTO_THREADS,
  )
}

/**
 * How many cluster workers `--threads` asks for, or `null` for "no cluster".
 *
 * `null` and `1` are different answers and `index.ts` branches on the
 * difference: `null` takes the single-process path, `1` still goes through
 * `handleThreadsMaster` with one worker.
 *
 * Both spellings of each flag are accepted (`--threads 4`, `--threads=4`, and
 * the `-t` forms). A flag with a non-numeric or absent value is not an error —
 * it falls back to `autoThreadCount()`, so `--threads --dev` asks for the
 * default rather than rejecting. `Math.max(1, …)` is what keeps `--threads 0`
 * from requesting a cluster with no workers in it.
 */
export function parseThreadsOption(args: string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--threads' || arg === '-t') {
      const next = args[i + 1]
      if (next && /^\d+$/.test(next)) {
        return Math.max(1, parseInt(next, 10))
      }
      return autoThreadCount()
    }
    if (arg.startsWith('--threads=') || arg.startsWith('-t=')) {
      const val = arg.split('=')[1]
      if (val && /^\d+$/.test(val)) {
        return Math.max(1, parseInt(val, 10))
      }
      return autoThreadCount()
    }
  }
  return null
}
