# ORM — remaining work before publish

Written 2026-08-08, from a scan of `packages/orm` (7,559 lines, non-test).
Local-only and gitignored, like CLAUDE.md and MONOREPO.md.

Everything below was **measured against live servers**, not inferred. MySQL
8.0.46 and PostgreSQL 16.4 were running locally from extracted vendor zips
under the session scratchpad; if they are gone, see *Reproducing the setup* at
the bottom.

```
MYSQL_TEST_URL=mysql://root:bakery@127.0.0.1:3306/bakery_test
PGSQL_TEST_URL=postgres://postgres:bakery@127.0.0.1:5432/bakery_test
```

Baseline after items 1-3 landed: **1269 pass / 0 fail** (`bun run test`),
**351 pass / 0 fail** with the URLs set, typecheck 0.

**Found while doing items 1-3, both verified directly:**

- **`transaction()` never worked on Postgres or MySQL.** Bun 1.3.14 exports
  `SQL` with `prototype === undefined`, so `x instanceof SQL` does not return
  false — it *throws* `instanceof called on an object with an invalid prototype
  property`. It looked fine only because `instanceof` short-circuits for a
  primitive before reading the right operand, so the string path never reached
  it; the one caller passing a real handle — `transaction()` wrapping the
  connection Bun hands its callback — failed every time. Fixed with a duck check
  (`isOpenConnection`). Confirmed load-bearing by reverting it: Postgres throws,
  restored it passes. Nothing had caught it because `apps/example` is SQLite, so
  the only end-to-end `db:sync` never exercised the other two.
- `iterate` is dead on all three dialects — see *Corrections* below.

---

## 1. ~~Bulk insert breaks past ~36k parameters~~ — DONE

Measured, SQLite, three columns per row:

| rows | params | result |
| --- | --- | --- |
| 12,000 | 36,000 | ok |
| 40,000 | 120,000 | `SQLite query expected 54464 values, received 120000` |
| 200,000 | 600,000 | `too many SQL variables` |

**54464 is 120000 − 65536.** The placeholder count wraps at 16 bits, so a large
insert does not fail cleanly — it fails with a number that reads like memory
corruption. Postgres and MySQL both cap at 65,535 placeholders.

Fix: chunk inside `InsertExecutable.parse()`/`run()` — batch under the dialect
ceiling and run the batches in one transaction so the insert stays atomic.
Ceiling belongs on the adapter (`maxQueryParams`), since only it knows the
dialect. Do **not** chunk a statement carrying `RETURNING`, or the result set
has to be stitched back together — either accumulate the rows or refuse.

## 2. ~~`values(array)` silently misbehaves~~ — DONE

`values()` is variadic (`values(...records)`), so the natural-looking
`values(rows)` treats the array as a single record and fails with
`table big has no column named 0`.

Fix: accept an array as well as a spread — detect an array whose first element
is a plain object — or throw a message naming `values(...rows)`. Silence is the
one option to rule out.

## 3. ~~Nothing times a query~~ — DONE (`setQueryObserver`)

No hook, no duration, no slow-query signal anywhere in `adapters/base.ts`.

This matters more here than in most ORMs **because the dashboard and analytics
plugins already exist** and have nowhere to read from. An
`onQuery({ sql, params, ms, rows, driver })` hook on the adapter, called from
`createExecutor`, is enough to build a "slowest queries" panel later.

Keep it free when unset — a null check, not an emitter — because it sits in the
hot path of every statement. Never log parameter *values* by default: they are
user data.

---

## 4. Nested transactions throw

```
cannot call begin inside a transaction use savepoint() instead
```

Verified live. Any composed code where two transactional functions call each
other crashes — `createUser()` inside `importUsers()`, both reasonable. Bun's
driver names the fix in its own error message.

The only remaining **correctness** gap, and the smallest of the big ones.
`transaction()` should detect that it is already inside one and issue
`SAVEPOINT` / `RELEASE` / `ROLLBACK TO` instead of `BEGIN`.

## 5. What the ledger just made possible

`__bakery_schema` is append-only and holds every applied schema. Three features
are now mostly plumbing that already exists:

- **`db:rollback`** — the previous schema is literally stored. Diff current
  against previous and apply it backwards. No migration files, no hand-written
  down-migrations.
- **`db:history`** — `SELECT applied_at, payload FROM __bakery_schema ORDER BY
  id` is already a changelog nothing surfaces.
- **Boot-time drift warning** — `resolveCurrentState()` already detects when the
  database stopped matching the ledger and silently falls back to introspection.
  It could say so at startup, which is how you find out someone ALTERed
  production by hand.

This trio is the genuinely differentiating work. Nothing else in the Bun
ecosystem is positioned for it.

## 6. Cheap, high-signal additions

- **`Field.Timestamps()`** — expands to `createdAt` + `updatedAt`, the latter
  maintained on write. The most copy-pasted pair in any schema.
- **`Field.Enum([...])`** — native `ENUM` on MySQL, `CHECK` elsewhere, and a
  *union type* in the inferred row rather than `string`.
- **`Field.Uuid()`** — with the correct per-dialect default.
- **Connection pool configuration** — nothing in `connection.ts` exposes size or
  idle timeout.

## 7. Known gaps left open on purpose

- **Relations / eager loading.** The obvious "missing ORM feature", but adding
  it changes what this library is. The query builder is strong enough that
  "explicit joins only" is defensible — it just needs **saying** in the docs
  rather than looking like an oversight. N+1 is the default path today.
- **`length` is not part of the column diff**, so widening a `Varchar` does not
  migrate. Adding it needs every adapter to report width back exactly; any that
  did not would rebuild the table forever.
- **FULL OUTER JOIN, UNION/INTERSECT/EXCEPT, window functions** — absent.
  `paginate()` is offset-only, which degrades past a few hundred thousand rows
  where cursor pagination is the standard answer.
- **Composite foreign keys** work by construction but were only tested
  single-column.

## Corrections to earlier assumptions

- ~~Streaming already exists.~~ **Wrong — I asserted this and it is false.**
  `QBExecutable.iterable()` exists but **throws on every dialect**:

  ```
  row of getActiveDb().query(sql).iterate is not a function
  ```

  Bun 1.3.14 `SQLQuery` has neither `Symbol.iterator` nor
  `Symbol.asyncIterator` — it is only a thenable — so `Executor.iterate` has
  never worked, on any adapter, and nothing tests it. Streaming is therefore a
  **missing feature, not an existing one**, and the fix is either to page with
  LIMIT/OFFSET under the generator or to use a driver cursor where one exists.

  Verified twice: once by the observability agent, once directly.

- **MySQL reports `changes: 0` for INSERTs.** Pre-existing in
  `MySQLAdapter`'s `RunResult` computation, not caused by the observer work.
  Anything trusting `.run().changes` to confirm a MySQL write is trusting a
  zero. Worth a look before publish.
- **`foreign()` no longer aborts** and is fully implemented on all three
  adapters, including `ON DELETE`/`ON UPDATE`.

---

## Reproducing the live-server setup

No Docker, Podman, WSL or local DB service on this machine. Both servers were
official vendor zips, extracted and run in place — no installer, no admin, no
service registration, deletable by removing the directory.

- PostgreSQL 16.4 — `get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip`
  (~323 MB). `initdb -U postgres --pwfile`, then `pg_ctl -o "-p 5432"`.
- MySQL 8.0.46 — `cdn.mysql.com//Downloads/MySQL-8.0/mysql-8.0.46-winx64.zip`
  (~236 MB). `mysqld --initialize-insecure`, start, then
  `ALTER USER 'root'@'localhost' IDENTIFIED BY 'bakery'`.

Download in the **foreground**; a backgrounded `curl` dies with its shell and
leaves a truncated file that still looks plausible. `curl -C -` on a server that
ignores the range appends a second copy — verify with `unzip -l` before
extracting.

`bun test ./packages/orm` runs the live half only when the two URLs are set;
without them those tests **skip**, and a skip is not a pass.
