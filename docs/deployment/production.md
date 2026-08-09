# Production

Production is the default, and there is no build step: the process is in
production mode unless `--dev` is on the command line
(`packages/core/src/core/init.ts`).

**Set `NODE_ENV=production` anyway.** The framework's own mode does not read it,
but one thing does, and it is the most destructive operation here: the schema
sync's guard on dropped tables, dropped columns and table rebuilds is
`process.env.NODE_ENV === 'production'` and nothing else
(`isProductionSync` in `packages/orm/src/sync/engine.ts`). Without it a
destructive plan on a production host falls through to the interactive
"Proceed with sync?" prompt instead of refusing outright. See
[Migrations](#migrations).

```bash
bunx bakery
```

That is `@bakery-framework/cli`'s `bin`. In the example app the same thing is wrapped as
`bun run serve`.

## What starts, in what order

`packages/cli/src/index.ts` is a **dispatcher**, not a server. It picks one of
four entry chains from the flags:

| Command | Chain | Notes |
| --- | --- | --- |
| `bakery --dev` | `index.ts` → `watcher.ts` → `compiler/dev-service.ts` | master; spawns the dev worker |
| *(internal)* `--dev-worker` | `index.ts` → `dev.ts` → `worker.ts` | the process that actually serves in dev |
| `bakery` | `index.ts` → `prod.ts` → `worker.ts` | production, single process |
| `bakery --threads N` | `index.ts` → `threads.ts` → N × `worker.ts` | cluster |

In production, `prod.ts` loads the config, runs plugin `setup()`, builds the
import maps, then calls `initDB()` — and **exits 1** if any of that fails
(`packages/cli/src/prod.ts`). A production process that cannot reach its
database does not start half-working.

`worker.ts` is the only file that owns a `Bun.serve`. Per request it resolves
the hostname, enters the per-host config scope, applies the rate limit, then
routes (`packages/cli/src/worker.ts`).

## Flags

| Flag | Effect |
| --- | --- |
| `--sync`, `-s` | Run schema sync before boot (`index.ts`) |
| `--threads N`, `-t N` | Fork a cluster of N workers (production only) |
| `--dev` | Development mode with the watcher and live reload |

`--threads` with no number picks `min(max(1, hardwareConcurrency), 8)`
(`index.ts`). `--threads=N` also works.

## Clustering

Bun's runtime is single-threaded per process, but Bakery is not limited to one
process. `--threads N` spawns N workers that share a listening socket via
`SO_REUSEPORT` (`packages/cli/src/worker.ts`):

```bash
bunx bakery --threads 4
```

- Workers share one `SharedArrayBuffer`, passed at spawn
  (`packages/cli/src/threads.ts`). Rate-limit buckets and request counters
  are therefore **process-wide**, not per worker — the budget you configure is
  the budget across the cluster.
- Worker `0` prints the startup banner; the rest are silent
  (`packages/core/src/startup.ts`).
- A worker that exits unexpectedly is respawned with exponential backoff:
  100 ms, doubling per consecutive failure up to 30 s, so a worker that
  crashes during boot (bad DB URL, port conflict) does not re-run its whole
  startup ten times a second. A worker that survives a minute resets its
  streak. There is deliberately no give-up ceiling (`threads.ts`).
- Caches shrink in workers: session memory tier ÷4, prepared-statement cache
  15 instead of 50, SQLite page cache smaller
  (`packages/core/src/cache/tiered.ts`, `cache/shared-db.ts`).

**On any platform other than Linux, `--threads N` becomes 1** — kernel-level
`SO_REUSEPORT` load balancing is Linux-only, so on Windows and macOS the master
logs a warning naming the platform and runs the server in-process
(`threads.ts`). A cluster of one is deliberately identical to plain `bakery`:
the single-worker path does not set `THREAD_WORKER`, so none of the
cache-shrinking a real worker does applies. `--threads` is ignored entirely
under `--dev` (`index.ts`).

Sessions are the one thing clustering complicates: each worker keeps its own
in-memory tier and flushes to the shared SQLite store every 30 seconds. See
[Sessions](../guides/sessions.md#where-sessions-are-stored).

## Directories: what must persist

Two directories, and the distinction matters more than anything else on this
page.

| Path | Contents | Redeploy |
| --- | --- | --- |
| **`bakery/`** | `server.db`, `backups/` | **Must survive.** This is your database. |
| `.cache/` | compiled assets, static cache, `server.json`, `shared-cache.db` | Disposable. Rebuilt on demand — including sessions, which do not survive a framework upgrade. |

The visible one is the precious one, deliberately: the framework deletes
`.cache/` wholesale on its own, so the directory it can never reach is the one
that is *not* hidden — a `rm -rf .*` or a "clean the dotfiles" sweep cannot
touch your database (`packages/core/src/core/bakery.ts`). Both paths are
resolved against the working directory, and both are in the default blocked-path
list so neither is ever served
(`packages/core/src/utils/constants.ts`).

`.cache` is wiped automatically whenever the mode or the app version
changes (`packages/core/src/core/config.ts`), so a stale cache after a
deploy is not a failure mode you have to plan for. The process does need write
access to it: a fully read-only filesystem will not work.

If you point the ORM at Postgres or MySQL, `bakery/` holds only `backups/` —
the session store lives in `.cache/` and is rebuilt from empty after any
framework upgrade.

## Docker

The volume goes on **`/app/bakery`**. Not `/app/.server`, not
`/app/.server/database` — those paths do not exist and mounting them does
nothing, which means the database gets baked into the image layer and is
**destroyed on every redeploy**.

```dockerfile
FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# The database, its backups, and the session store.
VOLUME ["/app/bakery"]

CMD ["bunx", "bakery"]
```

```yaml
services:
  app:
    build: .
    ports: ['3000:3000']
    volumes:
      # This line is the difference between a database and a fresh one.
      - bakery-data:/app/bakery
    environment:
      NODE_ENV: production

volumes:
  bakery-data:
```

Do not mount a volume over `/app` itself — that hides the application.

Verify it once, on a throwaway deploy, before you need it:

```bash
docker compose exec app ls -la /app/bakery
docker compose down && docker compose up -d
docker compose exec app ls -la /app/bakery   # server.db still there?
```

## Behind a reverse proxy

Bakery does not terminate TLS. Put nginx, Caddy or a load balancer in front, and
tell Bakery to believe it:

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  host: '127.0.0.1',
  trustProxy: true,
})
```

`trustProxy: true` makes three things read forwarded headers: the client IP
(which the rate limiter keys on), the hostname (which multi-host routing uses),
and `x-forwarded-proto` (which marks the session cookie `Secure`). Only turn it
on when the proxy is the sole path to the process — otherwise any client can
forge all three. Binding `host: '127.0.0.1'` is how you guarantee that.

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host              $host;
  proxy_set_header X-Forwarded-Host  $host;
  proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  proxy_http_version 1.1;
  proxy_set_header Upgrade    $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

The `Upgrade` lines are needed for WebSocket routes.

**Rate limiting is already on** (100 burst, 10/s refill, per client IP) — the
startup banner says so whenever the default is in effect. Do not
add a second layer at the proxy without checking what the first one is doing —
the knob you want is in `server.config.ts`. See
[Server config](../configuration/server-config.md#rate-limiting).

## Migrations

Schema sync is a separate command, not part of boot:

```bash
bun run db:sync              # apply schema.ts to the database
bun run db:sync --dry-run    # show the plan, change nothing
bun run db:sync --choose=db  # regenerate schema.ts from the database
```

With `NODE_ENV=production`, a plan containing anything destructive — dropped or
renamed tables, dropped or renamed columns, SQLite table rebuilds, view updates,
dropped indexes — **refuses to run** and exits 1 unless you pass `--force-sync`
(`packages/orm/src/sync/engine.ts`). Outside production it prompts
instead.

A destructive migration also requires a backup to have actually been written; if
the backup fails, or the database is in-memory, or the dump tool is missing, the
sync aborts (`packages/orm/src/sync/engine.ts`). `backups` in
`server.config.ts` caps how many are kept.

`bakery --sync` runs the same thing at boot (`index.ts`). It is convenient
in a container; it also means a bad schema change takes the service down at
start rather than at a moment you chose. Prefer running the migration as its own
step.

## Shutdown

`SIGINT` and `SIGTERM` stop the server, then run the shutdown sequence in
`packages/cli/src/shutdown.ts`: your `server.config.ts` `onShutdown` first, then
every `Bakery.onShutdown` hook, then plugin `onShutdown` hooks, then exit 0.

The app hook goes first deliberately. It is the only participant that might
still *need* the framework intact — step two flushes the tiered caches and
closes the cache database, so an app writing a last session value has to run
before that. It also mirrors startup exactly in reverse: plugins start first and
the app hook last, so last up is first down. Each step is isolated, because a
shutdown that aborts halfway loses precisely the data it exists to save. The hooks are what flush the tiered
caches to disk (`packages/core/src/cache/tiered.ts`), so a graceful stop
does not lose buffered session writes. `SIGKILL` loses up to 30 seconds of them.

Register cleanup either way: `onShutdown` in `server.config.ts` for app-level
work, or `Bakery.onShutdown(fn)` from anywhere for a hook registered at runtime.

Give containers a real stop timeout rather than the default 10 seconds if your
shutdown hooks do work.

In cluster mode the master asks every worker to run its shutdown sequence and
waits — up to 5 seconds — for each to acknowledge before terminating it
(`packages/cli/src/threads.ts`). A wedged worker delays shutdown, never
prevents it; only a worker that misses that deadline can lose buffered writes.

## Checklist

- [ ] `bakery` is on a persistent volume, and you have verified it survives a
      redeploy.
- [ ] `NODE_ENV=production` set in the process environment — it is the only
      thing that arms the destructive-sync guard
      (`packages/orm/src/sync/engine.ts`).
- [ ] `PORT` set if your platform assigns one — it overrides `port` in the
      config (`packages/cli/src/worker.ts`).
- [ ] `trustProxy` on **only** if a proxy is the only way in, with `host` bound
      to loopback.
- [ ] Rate limit reviewed rather than duplicated.
- [ ] Dashboard plugin either removed, or given an `authorize` predicate — see
      [Security](security.md).
- [ ] `DASHBOARD_ALLOW_WRITES` **not** set.
- [ ] Migrations run as an explicit step, with a verified backup.
- [ ] A stop timeout long enough for shutdown hooks.
