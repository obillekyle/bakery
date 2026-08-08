/**
 * Connection pool settings for the MySQL and Postgres adapters.
 *
 * Nothing exposed these before: every deployment ran on Bun's defaults, which
 * is fine until an app with more workers than the server has connection slots
 * meets `FATAL: sorry, too many clients already`. `--threads N` makes that a
 * realistic shape rather than a theoretical one — each worker opens its own
 * pool, so the number that matters is `max x threads`.
 *
 * **SQLite ignores all of it**, and that is not an omission: a SQLite adapter
 * is one file handle, and there is no pool to size.
 */
export interface PoolOptions {
  /** Maximum concurrent connections. Bun's default is 10. */
  max?: number
  /** Seconds an idle connection is kept before being closed. */
  idleTimeout?: number
  /** Seconds to wait for a connection before giving up. */
  connectionTimeout?: number
  /** Seconds after which a connection is retired and replaced. */
  maxLifetime?: number
}

/**
 * The env var behind each option.
 *
 * Environment rather than `server.config.ts` because pool size is a property
 * of the *deployment*, not of the app: the same build runs with one connection
 * on a laptop and forty in production, and `--threads N` multiplies whatever
 * is set here per worker.
 */
const ENV_KEYS: Record<keyof PoolOptions, string> = {
  max: 'DB_POOL_MAX',
  idleTimeout: 'DB_POOL_IDLE_TIMEOUT',
  connectionTimeout: 'DB_POOL_CONNECTION_TIMEOUT',
  maxLifetime: 'DB_POOL_MAX_LIFETIME',
}

/**
 * Read pool options from the environment, dropping anything unusable.
 *
 * Unset stays unset — an option Bakery does not pass is one Bun defaults,
 * which is different from passing Bun a zero. A non-numeric or negative value
 * is dropped for the same reason: `DB_POOL_MAX=lots` must not become
 * `max: NaN`, which Bun would take and then behave unpredictably around.
 *
 * **Only known keys are ever forwarded**, and that matters more than it looks:
 * Bun accepts an unrecognised option silently — verified, `new SQL(url, {
 * totallyNotAnOption: 1 })` constructs and queries fine — so a typo'd key
 * would configure nothing and report nothing. Passing a fixed set means the
 * typo lands in an env var name, where it is at least visible in one place.
 */
export function poolOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PoolOptions {
  const out: PoolOptions = {}
  for (const [key, envKey] of Object.entries(ENV_KEYS) as [
    keyof PoolOptions,
    string,
  ][]) {
    const raw = env[envKey]
    if (raw === undefined || raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) continue
    out[key] = n
  }
  return out
}

/**
 * Merge pool options into the object handed to `new SQL()`.
 *
 * The timeouts are **seconds here and milliseconds inside Bun** — it multiplies
 * by 1000 on the way in, verified by reading `sql.options` back: `idleTimeout:
 * 5` is stored as `5000`. Seconds is what Bun's own documented unit is, so this
 * passes them straight through rather than converting and doubling the factor.
 */
export function withPoolOptions<T extends object>(
  base: T,
  pool: PoolOptions = poolOptionsFromEnv(),
): T & PoolOptions {
  return { ...base, ...pool }
}
