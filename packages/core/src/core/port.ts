/**
 * The one answer to "what port are we on".
 *
 * This was written three times, with three different rules, in three files that
 * all have to agree or the framework lies to the developer:
 *
 * - `cli/worker.ts` decides the port `Bun.serve` actually binds.
 * - `startup.ts` decides the port the startup banner prints.
 * - `compiler/dev-service.ts` decides the URL the dev master advertises.
 *
 * They drifted on two axes. `parseInt` (startup, dev-service) reads `3000x` as
 * `3000`; `Number` (worker) reads it as `NaN`, and `Bun.serve({port: NaN})`
 * quietly binds an **ephemeral** port — so `PORT=3000x` printed
 * `http://localhost:3000/` while the server was listening on 51570. And the
 * final fallbacks differed (`Bakery.server?.port || 0` against a literal
 * `3000`), so the two survivors of a bad parse disagreed again.
 *
 * The rule here is `Number` plus an explicit range check, and a malformed
 * `PORT` is an **error** rather than a guess. Convention 2 is about guards, but
 * the same instinct applies: a value the operator plainly meant as a port and
 * which is not one has no safe default. Silently binding 3000 hides a typo in a
 * deploy script until something else is already on 3000; silently binding a
 * random port hides it until a health check times out. Failing at boot names
 * the variable and its value while the operator is still looking at the
 * terminal.
 *
 * `0` is deliberately *not* an error — it is the documented "let the OS pick
 * one" port, and `startup.ts` prefers `Bakery.server.port` precisely so the
 * banner prints the port that was picked rather than the `0` that was asked
 * for.
 */

/** Where `PORT` and a portless `server.config.ts` both land. */
export const DEFAULT_PORT = 3000

/** Highest port number a TCP socket can bind. */
const MAX_PORT = 65535

// 🚀 Hoisted Regex
const RE_DECIMAL = /^\d+$/

/**
 * Resolve `PORT` → `configPort` → {@link DEFAULT_PORT}.
 *
 * An unset *or empty* `PORT` counts as absent: `PORT=` is how a shell and a
 * process manager both spell "no value", and all three call sites already
 * treated it that way.
 *
 * @throws if `PORT` is set to anything that is not an integer in `0..65535`.
 */
export function resolvePort(configPort?: number | null): number {
  const raw = process.env.PORT

  if (raw !== undefined && raw.trim() !== '') {
    const trimmed = raw.trim()
    // Decimal digits only, deliberately narrower than `Number`: `Number` also
    // accepts `0x1f` (31), `1e3` (1000) and `+80`, none of which anyone types
    // into a `PORT` on purpose, and all of which would resolve to a port the
    // operator did not write down.
    const parsed = RE_DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PORT) {
      throw new Error(
        `Invalid PORT: ${JSON.stringify(raw)} is not an integer between 0 and ${MAX_PORT}`,
      )
    }
    return parsed
  }

  // `||`, not `??`: a config that says `port: 0` has always meant "unset" here
  // rather than "ephemeral", and only `PORT=0` asks for an ephemeral port.
  // Changing that is a separate decision from unifying the three call sites.
  return configPort || DEFAULT_PORT
}

/**
 * `--port 8080`, `--port=8080`, `-p 8080`, `-p=8080`.
 *
 * Returns the raw string so the caller can validate it through the one rule
 * above rather than a second one — a flag that accepted `0x1f` where `PORT`
 * rejects it would be exactly the drift this module exists to end.
 */
function portFlagValue(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' || arg === '-p') return argv[i + 1] ?? ''
    if (arg.startsWith('--port=')) return arg.slice('--port='.length)
    if (arg.startsWith('-p=')) return arg.slice('-p='.length)
  }
  return null
}

/**
 * Fold a `--port` flag into `process.env.PORT`, before anything reads it.
 *
 * **Why the env rather than a parameter.** The port is read in three places
 * (see the note at the top of this file) across up to three *processes*: the
 * dev master, the dev worker it spawns, and N cluster workers. The spawn sites
 * pass `env: {...process.env}` and build their argv explicitly — `dev-service`
 * forwards `--dev`, `--dev-worker` and `--sync`, and nothing else — so a flag
 * would have to be threaded through each of them and kept in step forever,
 * while an environment variable already propagates to all of them. Normalising
 * once, in the entry, means every existing reader is already correct.
 *
 * **Precedence: flag beats `PORT` beats config.** That is what `--port` means
 * everywhere else a developer has met it (Vite, Next, Astro, Nuxt), and an
 * explicit argument losing to an inherited environment variable would be the
 * surprising order. It is also the recoverable one: a shell with a stale
 * exported `PORT` is fixed by typing the flag, whereas the reverse needs the
 * developer to work out which variable is winning.
 *
 * @throws if the flag is present but its value is not an integer in `0..65535`,
 *   including when it is missing entirely (`bakery --port` with nothing after
 *   it). A flag typed and then ignored is worse than one that complains.
 */
export function applyPortFlag(argv: string[] = process.argv.slice(2)): void {
  const raw = portFlagValue(argv)
  if (raw === null) return

  const trimmed = raw.trim()
  const parsed = RE_DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PORT) {
    throw new Error(
      `Invalid --port: ${JSON.stringify(raw)} is not an integer between 0 and ${MAX_PORT}`,
    )
  }

  process.env.PORT = String(parsed)
}
