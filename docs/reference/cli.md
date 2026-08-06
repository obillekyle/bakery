# CLI reference

There are two executables. `@bakery/cli` owns the `bakery` bin and runs the
server; `@bakery/orm` owns schema sync. They have separate flag sets and do not
share a parser.

```bash
bunx bakery --dev
```

```bash
bun run db:sync --dry-run
```

Both resolve everything against `process.cwd()`, so run them from the
application directory — the one containing `server.config.ts`.

## bakery

[`packages/cli/src/index.ts`](../../packages/cli/src/index.ts) is not a server.
It is a **process-mode dispatcher**: it reads the mode flags, then hands off to
one of four files. Reading it alone will not tell you where requests are served.

| Mode | Invocation | Chain |
| --- | --- | --- |
| development | `bakery --dev` | `index.ts` → `watcher.ts` → `compiler/dev-service.ts` |
| dev worker | `--dev --dev-worker` (spawned for you) | `index.ts` → `dev.ts` → `worker.ts` |
| production | `bakery` | `index.ts` → `prod.ts` → `worker.ts` |
| cluster | `bakery --threads 4` | `index.ts` → `threads.ts` → N × `worker.ts` |

`worker.ts` is the only file in the codebase that calls `Bun.serve`.

### Flags

| Flag | Effect |
| --- | --- |
| `--dev` | development mode: file watcher, live reload, schema sync on every boot |
| `--threads N`, `-t N` | fork a cluster of N workers. **Production only** |
| `--threads=N`, `-t=N` | same, `=` form |
| `--sync`, `-s` | run schema sync before starting |
| `--dev-worker` | internal: marks the spawned dev child |
| `--thread-worker`, `--thread-id N` | internal: marks a cluster worker |
| `--inspect*` | forwarded to the dev worker so the debugger attaches to the process that serves |

That is the entire list.

> **Unknown flags are silently ignored, and there is no `--help`.** The parser
> only looks for the strings above; anything else falls through to the default
> branch, which is *production mode*. So `bakery --help` and `bakery --port 8080`
> both start a production server
> ([packages/cli/src/index.ts](../../packages/cli/src/index.ts)).

### Port and host

**There is no port flag.** The port is resolved as
`process.env.PORT` → `port` in `server.config.ts` → `3000`
([packages/cli/src/worker.ts](../../packages/cli/src/worker.ts)):

```bash
PORT=8080 bunx bakery
```

The host comes from `host` in `server.config.ts`, defaulting to `0.0.0.0`. When
it is `0.0.0.0` or `::`, the startup banner enumerates the machine's non-internal
IPv4 addresses so you can reach the dev server from another device
([packages/core/src/startup.ts](../../packages/core/src/startup.ts)).

### `--sync`

Runs `SyncService.run()` before dispatching, and is skipped inside dev workers
and cluster workers so N processes do not race the same migration
([packages/cli/src/index.ts](../../packages/cli/src/index.ts)).

**Development already does this.** `dev.ts` runs schema sync unconditionally on
every boot ([packages/cli/src/dev.ts](../../packages/cli/src/dev.ts)), so
`--sync` is really a production affordance:

```bash
bunx bakery --sync
```

### Development mode

`bakery --dev` starts a supervisor, which spawns the actual server as a child
with `--dev --dev-worker`. The child is what binds the port; the parent watches
files and restarts it. Two processes, one port.

The watcher decides per changed file
([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)):

| Changed | Result |
| --- | --- |
| `server.config.ts`, any `**/*.tsx` | worker exits 42; supervisor clears the screen and restarts it |
| `.ts`, `.js`, `.html`, `.vue` | route caches cleared, live-reload message pushed |
| `.css` | live-reload message pushed |

Ignored entirely: `node_modules`, `.git`, `.vscode`, `.cache`, `.bakery`, and a
top-level `schema.ts`. Anything without a `.css/.html/.ts/.js/.tsx/.jsx/.vue`
extension is dropped by an extension filter before any of the above
([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)).

> **Editing `package.json` or `bun.lock` does nothing at all** — not even a log
> line. There is a branch meant to report those, but the extension filter runs
> first and neither file matches it, so the branch is unreachable
> ([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)).
> Restart the dev server yourself after installing a dependency.

While the server is up and no prompt is waiting, the terminal is in raw mode and
accepts two keys ([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)):

| Key | Action |
| --- | --- |
| `s` | stop the supervisor and the worker |
| `Ctrl-C` | send SIGINT to the worker |

Raw mode is dropped automatically while the sync engine is waiting on a
confirmation prompt, so you can actually answer it.

### Cluster mode

```bash
bunx bakery --threads 4
```

`--threads` with no number picks
`min(max(1, navigator.hardwareConcurrency || 4), 8)` — capped at 8
([packages/cli/src/index.ts](../../packages/cli/src/index.ts)).

- **Ignored under `--dev`**, with no warning. The dispatcher checks `!isDev`
  before taking the cluster branch.
- **Windows is capped at 1 worker**, with a warning. Windows has no
  `SO_REUSEPORT`, so several processes cannot share a port
  ([packages/cli/src/threads.ts](../../packages/cli/src/threads.ts)).
- `THREAD_ID` 0 owns the startup banner; the others start silently.
- A worker that exits unexpectedly is respawned after 100 ms.
- Workers share one `SharedArrayBuffer` for the rate limiter and request
  counters, passed at spawn.
- With `--threads 1` (or on Windows) no cluster is created at all: the process
  sets `THREAD_WORKER=1` and runs the production path in-process.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | clean shutdown |
| 1 | fatal startup error — config, database, server setup, or a refused sync |
| 42 | **worker asks the supervisor to restart it.** Not an error |
| 130 | interrupted; the supervisor logs the shutdown and exits 0 |

42 is worth knowing if you run the worker under an external supervisor: it means
"restart me", and treating it as a crash loop is a misreading.

## db:sync

```bash
bun run db:sync
```

Runs [`packages/orm/src/sync/index.ts`](../../packages/orm/src/sync/index.ts),
which loads `server.config.ts`, connects, finds the schema, diffs it against the
database, and applies the difference.

| Flag | Effect |
| --- | --- |
| `--choose=ts` | apply `schema.ts` to the database. **Default** |
| `--choose=db` | regenerate `schema.ts` from the database |
| `--dry-run` | print the plan, change nothing |
| `--force-sync` | allow destructive changes in production |
| `--help`, `-h` | print this list |

A change is **destructive** if it drops or renames a table or column, rebuilds a
table, updates a view, or drops an index — including an index that exists in the
database but not in your schema, which is how a hand-added production index gets
silently removed ([packages/orm/src/sync/engine.ts](../../packages/orm/src/sync/engine.ts)).

For a destructive plan:

- In development, you are prompted. A non-TTY (CI, Docker) **declines**, rather
  than treating an unanswerable prompt as consent
  ([packages/core/src/logger/logger.ts](../../packages/core/src/logger/logger.ts)).
- In production, it refuses and exits 1 unless `--force-sync` is passed.
- Either way a backup is taken first, and if the backup fails the sync aborts
  ([packages/orm/src/sync/engine.ts](../../packages/orm/src/sync/engine.ts)).

> **"Production" here means `NODE_ENV=production`, and only that.** Set it on
> production hosts.
>
> The check used to also test `process.env.PROD === 'true'`, which never fired —
> `core/init.ts` installs `PROD` as a getter returning a **boolean**. That term
> was deleted rather than repaired: `PROD` means only "`--dev` is absent", and
> `db:sync` is a separate invocation that never passes `--dev`, so honouring it
> would make *every* standalone sync count as a deployment and leave the
> interactive `Proceed with sync?` unreachable.

Two things exit 1 before any diffing:

- A `schema` path configured in `server.config.ts` that does not exist. This is
  deliberately not a fallback to auto-detection: a typo would otherwise have the
  generator write a fresh schema at the wrong path while your real model sat
  untouched.
- Any `foreign()` declaration. No adapter emits `FOREIGN KEY` DDL, so it would
  be created as a plain index and then re-diffed forever. Use `index()` and
  enforce the reference in application code.

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `PORT` | worker, dev supervisor | overrides `port` in the config |
| `DB_URL` | adapter factory | connection string; the driver is inferred from the scheme |
| `DATABASE_URL` | adapter factory, SQLite adapter | same, checked second |
| `SQLITE_PATH` | SQLite adapter | database file when no URL is given |
| `NODE_ENV` | init, sync engine | `test` sets `import.meta.env.TEST`; `production` arms the destructive-sync guard |
| `THREAD_WORKER`, `THREAD_ID` | init, cluster | set by the supervisor; do not set by hand |
| `DETACHED` | dev supervisor | `1` detaches the worker's stdin and hides its window |
| `DEV_WATCHER_ACTIVE` | logger, sync engine | set by the supervisor so prompts and restarts coordinate |
| `DASHPASS`, `DASHBOARD_ALLOW_WRITES` | dashboard plugin | see [Dashboard](../plugins/dashboard.md) |

`.env` files are read by Bun itself, not by Bakery.

### `import.meta.env`

`core/init.ts` defines these as getters on `process.env`, which is why **it must
be the first import in every entry file** — everything downstream branches on
them ([packages/core/src/core/init.ts](../../packages/core/src/core/init.ts)).

| Key | Type | Value |
| --- | --- | --- |
| `DEV` | boolean | `--dev` or `--dev-worker` present |
| `PROD` | boolean | neither `--dev` nor `--dev-worker` |
| `TEST` | boolean | `NODE_ENV=test` |
| `WORKER` | boolean | dev worker or cluster worker |
| `DEV_WORKER` | boolean | `--dev-worker` |
| `THREAD_WORKER` | boolean | cluster worker |
| `THREAD_ID` | string | `'0'` unless set |
| `MODE` | string | `development` \| `production` \| `dev-worker` \| `thread-worker` |

These are booleans, not the strings `process.env` usually holds. Compare them
with `if (import.meta.env.DEV)`, never against `'true'`.

## Running from the repo root

The root `package.json` scripts `cd apps/example` first. They are shorthand for
the demo app, not general-purpose commands:

| Root script | Actually runs |
| --- | --- |
| `bun run dev` | `apps/example` → `bun --smol run ../../packages/cli/src/index.ts --dev` |
| `bun run serve` | `apps/example` → the same without `--dev` |
| `bun run db:sync` | `apps/example` → `bun --smol run ../../packages/orm/src/sync` |
| `bun run test` | `bun test ./packages ./tests` |
| `bun run typecheck` | `tsc --noEmit` across all nine projects |

`--smol` is Bun's reduced-memory mode. Nothing depends on it; drop it if you
would rather trade memory for throughput.
