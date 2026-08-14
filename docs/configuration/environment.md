# Environment

Bakery reads a small, fixed set of environment variables. Everything else about
the server is configured in [`server.config.ts`](server-config.md).

Bun loads `.env` from the working directory automatically, so a `.env` file next
to your `server.config.ts` is enough — there is no dotenv dependency to add and
nothing to call. `.env` is in the default blocked-path list, so it is never
served (`packages/core/src/utils/constants.ts`).

## Variables the framework reads

| Variable | Read by | Effect |
| --- | --- | --- |
| `PORT` | `packages/cli/src/worker.ts` | Listening port. **Overrides `port` in the config.** |
| `DB_URL` | `packages/orm/src/adapters.ts` | Database connection URL; selects the driver. |
| `DATABASE_URL` | `packages/orm/src/adapters.ts` | Same, used when `DB_URL` is unset. |
| `SQLITE_PATH` | `packages/orm/src/adapters/sqlite.ts` | SQLite file path, when neither URL is set. |
| `NODE_ENV` | `packages/core/src/core/init.ts`, `packages/orm/src/sync/engine.ts` | `test` sets `import.meta.env.TEST`; `production` makes `db:sync` refuse destructive changes without `--force-sync`. |
| `THREAD_WORKER` | `packages/core/src/core/init.ts` | Set to `1` by the cluster master. Marks this process a cluster worker. |
| `THREAD_ID` | `packages/core/src/core/init.ts` | Worker index within the cluster. Worker `0` prints the startup banner. |

`THREAD_WORKER` and `THREAD_ID` are set for you by the cluster master when you
run `--threads N` (`packages/cli/src/threads.ts`). They are listed because
you will see them in a process listing and because worker processes scale their
caches down when they are set (`packages/core/src/cache/tiered.ts`,
`packages/core/src/cache/shared-db.ts`) — not because you should set them
by hand.

The mode flags (`--dev`, `--threads`, `--sync`) are **command-line arguments,
not environment variables**. See [Production](../deployment/production.md).

## Database URLs

The driver is chosen by inspecting the URL (`packages/orm/src/adapters.ts`):

```bash
DB_URL=postgres://user:pass@localhost:5432/app   # postgres
DB_URL=mysql://user:pass@localhost:3306/app      # mysql
DB_URL=sqlite://./data/app.db                    # sqlite
DB_URL=./data/app.db                             # sqlite (a path is a path)
```

With nothing set, the ORM uses SQLite at `bakery/server.db`, resolved against the
working directory (`packages/orm/src/adapters/sqlite.ts`). That directory
holds real data and must survive a redeploy — see
[Production](../deployment/production.md).

`SQLITE_PATH` is consulted only when no URL was supplied. `DB_URL` and
`DATABASE_URL` win over it.

## `DASHPASS` is vestigial

Older material described `DASHPASS` as the dashboard password. It is not, and
setting it does not protect anything.

The dashboard no longer authenticates anyone. It takes an `authorize` predicate
from your application, and with none configured it allows loopback in
development and denies everything in production. The guard itself lives in core
(`packages/core/src/utils/http/authorize.ts`) and is shared with the analytics
plugin — the dashboard hands its predicate to analytics, which owns the
decision for both. The db-explorer plugin shares neither door: it has its own
access model, granting a level per caller rather than a yes, and configuring
the dashboard grants nothing there. See
[Database Explorer](../plugins/db-explorer.md).

```ts
import { defineConfig } from '@bakery-framework/core'
import dashboardPlugin from '@bakery-framework/plugin-dashboard'

export default defineConfig({
  plugins: [
    dashboardPlugin({ authorize: req => req.session.get('role') === 'admin' }),
  ],
})
```

One reference survives: the analytics plugin's stats endpoint still checks
`process.env.DASHPASS` before checking a session flag
(`packages/plugins/analytics/src/endpoints/stats.ts`). It fails closed —
unset gives `404`, set gives `401` unless the session already carries the
`__bakery.dashpass` key, which nothing in the framework issues any more. So
setting `DASHPASS` changes a status code and grants no access. Do not treat it
as a credential.

## `import.meta.env`

The mode flags are defined as getters on `process.env` by `core/init.ts`, which
is why `core/init.ts` must be the first import in any entry file. They are
derived from `process.argv`, not from the environment
(`packages/core/src/core/init.ts`):

| Flag | True when |
| --- | --- |
| `DEV` | `--dev` or `--dev-worker` is on the command line |
| `PROD` | neither `--dev` nor `--dev-worker` |
| `DEV_WORKER` | `--dev-worker` |
| `THREAD_WORKER` | `--thread-worker`, or `THREAD_WORKER=1` |
| `WORKER` | either worker flag |
| `THREAD_ID` | string; `THREAD_ID`, else `--thread-id`, else `'0'` |
| `TEST` | `NODE_ENV=test` |
| `MODE` | `'development'`, `'production'`, `'dev-worker'` or `'thread-worker'` |

`PROD` is what makes the session cookie `Secure` by default
(`packages/core/src/session.ts`) and what silences `debug` log lines
(`packages/core/src/logger/logger.ts`).

Four of these are also substituted into browser bundles at compile time —
`DEV`, `PROD`, `WORKER`, `MODE`, plus `BAKERY_VERSION`
(`packages/core/src/compiler/compiler.ts`). Client code can branch on them
and the dead branch is removed.

`ImportMetaEnv` used to declare a `SERVE_ROOT` that nothing defined or read —
so anything trusting it got `undefined` with the type `string`. It has been
removed; `Bakery.serveRoot` is the real value.

## Framework-internal variables

These are set by Bakery for its own child processes. Setting them yourself will
confuse the dev pipeline:

- `DEV_WATCHER_ACTIVE` — tells the schema sync it is running under the dev
  watcher, so it can exit with code 42 and ask for a restart
  (`packages/orm/src/sync/engine.ts`).
- `DETACHED` — dev service flag (`packages/core/src/compiler/dev-service.ts`).

## Test-only variables

`MYSQL_TEST_URL` and `PGSQL_TEST_URL` enable the live adapter round-trip tests
(`packages/orm/src/adapters/contract.test.ts`). Unset, those two tests
skip — which is why the suite reports 2 skipped on a normal machine.

## A production `.env`

```bash
PORT=3000
NODE_ENV=production
DB_URL=postgres://app:secret@db.internal:5432/app
```

Nothing else is required. Rate limiting, session cookie flags and blocked paths
are all on by default and configured in code, not here — see
[Security](../deployment/security.md).
