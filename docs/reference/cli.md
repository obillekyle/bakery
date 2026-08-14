# CLI reference

There are two executables. `@bakery-framework/cli` owns the `bakery` bin and runs the
server; `@bakery-framework/orm` owns schema sync. They have separate flag sets and do not
share a parser.

## The ORM is optional

`@bakery-framework/orm` is an **optional peer dependency** of the CLI, not a dependency.
An app scaffolded with `bun create bakery --no-orm` does not install it, and the
server runs without one: no connection is opened, no `bakery/` directory is
created, and nothing is logged about a database the app never asked for.

The distinction that matters is between *absent* and *broken*. Absence is
checked once, by asking the resolver whether `@bakery-framework/orm` is installed at all.
Everything downstream of that is unchanged — **if the ORM is present and
`initDB()` fails, the boot still dies with exit 1**, because at that point the
app does have a database and it does not work. A misconfigured `DB_URL` is not
quietly reinterpreted as "running without a database".

`--sync` is the exception: it is an explicit request to sync a database, so
with no ORM installed it fails with exit 1 and tells you to add the package,
rather than succeeding at nothing.

Adding it later is `bun add @bakery-framework/orm` — nothing in the CLI needs
reconfiguring, since the presence check is what drives all of this.

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
| `--port N`, `-p N` | bind this port. Also `--port=N` / `-p=N` |
| `--dev` | development mode: file watcher, live reload, schema sync when the schema changed |
| `--threads N`, `-t N` | fork a cluster of N workers. **Production only** |
| `--threads=N`, `-t=N` | same, `=` form |
| `--sync`, `-s` | run schema sync before starting |
| `--dev-worker` | internal: marks the spawned dev child |
| `--thread-worker`, `--thread-id N` | internal: marks a cluster worker |
| `--inspect*` | forwarded to the dev worker so the debugger attaches to the process that serves |

That is the entire list.

> **Unknown flags are silently ignored, and there is no `--help`.** The parser
> only looks for the strings above; anything else falls through to the default
> branch, which is *production mode*. So `bakery --help` starts a production
> server ([packages/cli/src/index.ts](../../packages/cli/src/index.ts)).

### Port and host

The port resolves in this order, through one shared resolver so that what the
server binds and what the startup banner prints cannot disagree
([packages/core/src/core/port.ts](../../packages/core/src/core/port.ts)):

`--port` → `process.env.PORT` → `port` in `server.config.ts` → `3000`

```bash
bunx bakery --port 8080
```

```bash
PORT=8080 bunx bakery
```

`--port`, `--port=`, `-p` and `-p=` are all accepted, and the flag beats an
inherited `PORT` — which is both what the flag means everywhere else a developer
has met it and the recoverable order: a shell with a stale exported `PORT` is
fixed by typing the flag, while the reverse leaves you working out which variable
is winning.

It works by folding into `process.env.PORT` in the CLI entry, before any mode
takes over. That is deliberate rather than incidental: the port is read in three
places across up to three *processes* — the dev master, the dev worker it spawns,
and N cluster workers — and the spawn sites build their argv explicitly while
already passing the environment through. One normalisation covers all of them.

**A malformed port is a boot error, not a fallback**, and the flag is checked by
the same rule as the variable rather than a second one — so `--port 0x1f` is
refused exactly as `PORT=0x1f` is. `bakery --port` with nothing after it is also
an error: a flag typed and then ignored is worse than one that complains.

**A malformed `PORT` is a boot error, not a fallback.** It must be digits in
`0..65535`; `PORT=3000x`, `0x1f`, `1e3` and `+80` are all refused with
`Invalid PORT: … is not an integer between 0 and 65535` and exit 1. An unset
or empty `PORT` counts as absent and falls through to the config. `PORT=0` is
allowed and means "let the OS choose" — the banner then reports the port
actually bound. Failing loudly is deliberate: a value the operator plainly
meant as a port and which is not one has no safe default, and the previous
behaviour was worse than a bad default — `Number('3000x')` is `NaN`, which
`Bun.serve` turns into a *random* ephemeral port while the banner advertised
`http://localhost:3000/`.

The host comes from `host` in `server.config.ts`, defaulting to `0.0.0.0`. When
it is `0.0.0.0` or `::`, the startup banner enumerates the machine's non-internal
IPv4 addresses so you can reach the dev server from another device
([packages/core/src/startup.ts](../../packages/core/src/startup.ts)).

### `--sync`

Runs `SyncService.run()` before dispatching, and is skipped inside dev workers
and cluster workers so N processes do not race the same migration
([packages/cli/src/index.ts](../../packages/cli/src/index.ts)).

**Development largely does this for you.** `dev.ts` checks the schema on every
boot, but runs the full sync only when a hash of the schema sources (plus the
DB target) differs from the one recorded after the last *successful* sync — a
failed sync never records, so the next boot re-syncs
([packages/cli/src/dev.ts](../../packages/cli/src/dev.ts),
[compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)).
Any indeterminate state — unreadable sources, no recorded hash, a missing local
database file — syncs rather than skips. Pass `--sync` to force it; the dev
master forwards the flag to its worker so a forced sync survives restarts. In
production, `--sync` is the only way sync runs at boot:

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
| `server.config.ts`, anything under the configured api directory | worker exits 42; supervisor restarts it (clearing the screen only if the worker had come up) |
| a **newly created** `.tsx` or `.jsx` | worker exits 42; supervisor restarts it |
| `.ts`, `.js`, `.tsx`, `.jsx`, `.html`, `.vue` | route caches cleared, live-reload message pushed |
| `.css` | live-reload message pushed |

`.tsx` pages deliberately take the cheap path: `TSXHandler` re-imports the page
module with a `?v=<mtime>` cache-buster, so a page edit needs a browser reload,
not a process restart. The one thing a restart still buys — flushing shared
components a page *imports* — is a documented limitation; see
[Your first app](../getting-started/first-app.md#what-reloading-does-and-does-not-do).

**Creating a page is the exception, and it costs a restart.** Bun caches the
directory listing it resolved an import against, so a `.tsx` that did not exist
when the worker booted fails to import at *any* specifier — including a
freshly-stamped `?v=<mtime>` one — and the page 500s with `Cannot find module`
until the process restarts. `isCreatedRouteModule` detects it from the watcher's
`rename` event plus the file still existing, and takes the restart
([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)).

The practical consequence is about your editor, not your code. An ordinary
in-place save (`Bun.write`, `fs.writeFile`, most editors) emits only `change`
and stays on the ~15 ms fast path. A writer that *replaces* the file — shell
redirection (`> file`), or an editor that saves atomically by writing a temp
file and renaming over the original — reports `rename` for an edit too, and pays
the ~440 ms restart on **every save**. That is the deliberate direction to be
wrong in: a slower save beats a page that does not serve at all. If your dev
loop feels like it restarts constantly, check whether your editor does atomic
saves.

Ignored entirely: `node_modules`, `.git`, `.vscode`, `.backups`, `.cache`,
`.cache`, `bakery`, and `schema.ts` at **any** depth (the ORM schema
convention — `orm/schema.ts` is covered too). Anything without a
`.css/.html/.ts/.js/.tsx/.jsx/.vue` extension is dropped by an extension filter
([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)).

> **Editing `package.json` or `bun.lock` logs a "changed" line and nothing
> else** — deliberately no restart, because `bun install` rewrites the lockfile
> several times and restarting on each would loop the dev server for the whole
> install ([packages/core/src/compiler/dev-service.ts](../../packages/core/src/compiler/dev-service.ts)).
> The line tells you a restart is warranted; you decide when.

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
- **Every platform except Linux is capped at 1 worker**, with a warning naming
  the platform. The multi-worker model needs kernel-level `SO_REUSEPORT` load
  balancing, which only Linux provides — on macOS N sockets either fail to bind
  or never receive balanced traffic
  ([packages/cli/src/threads.ts](../../packages/cli/src/threads.ts)).
- `THREAD_ID` 0 owns the startup banner; the others start silently.
- A worker that exits unexpectedly is respawned with exponential backoff —
  100 ms doubling per consecutive failure, capped at 30 s, streak reset after
  a minute of survival. There is no give-up ceiling.
- Workers share one `SharedArrayBuffer` for the rate limiter and request
  counters, passed at spawn.
- With `--threads 1` (or on any non-Linux platform) no cluster is created at
  all: the process sets `THREAD_ID=0` and runs the production path in-process.
  `THREAD_WORKER` is deliberately **not** set — it is the flag that scales
  caches down for N-way memory sharing, and a single worker owning the whole
  process would pay that for nothing. A cluster of one behaves identically to
  plain `bakery`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | clean shutdown |
| 1 | fatal startup error — config, database, server setup, a refused sync, or `--sync` with no `@bakery-framework/orm` installed |
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
- A foreign key whose target is neither a primary key nor uniquely indexed. SQL
  requires one, and the dialects disagree about how they object: MySQL and
  Postgres refuse the `CREATE`, while SQLite accepts it and then fails every
  insert with "foreign key mismatch". Checking first turns that into one
  message naming the reference.

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
| `DASHPASS` | **analytics** plugin | vestigial. Read only by `analytics/endpoints/stats.ts`; unset makes the stats endpoints 404, set makes them 401. Grants no access — see [Environment](../configuration/environment.md#dashpass-is-vestigial) |

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

## The scripts a generated app gets

`bun create bakery` writes these, and each is a thin wrapper over the `bin`:

| Script | Actually runs |
| --- | --- |
| `bun run dev` | `bakery --dev` |
| `bun run start` | `bakery` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:sync` | `bun run scripts/db-sync.ts` (with the ORM) |

`db:sync` is a script rather than `bakery --sync` because those are different
things: `--sync` syncs and then *boots the server*, which is the wrong shape for
a deploy step. The generated script calls `SyncService.run()` and exits.

## Running from this repo's root

Only relevant when working on the framework. The root `package.json` scripts
`cd apps/example` first — they are shorthand for the demo app, not
general-purpose commands:

| Root script | Actually runs |
| --- | --- |
| `bun run dev` | `apps/example` → `bun --smol run ../../packages/cli/src/index.ts --dev` |
| `bun run serve` | `apps/example` → the same without `--dev` |
| `bun run db:sync` | `apps/example` → `bun --smol run ../../packages/orm/src/sync` |
| `bun run test` | `bun test ./packages ./tests` |
| `bun run typecheck` | `tsc --noEmit` across all ten projects |

`--smol` is Bun's reduced-memory mode. Nothing depends on it; drop it if you
would rather trade memory for throughput.
