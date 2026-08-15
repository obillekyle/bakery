# Database explorer plugin

`@bakery-framework/plugin-db-explorer` serves a database client at `/_db`: a
table list, tabs, a paged and filtered grid, Structure and Relations views for
every table, inline and side-panel row editing, bulk actions, foreign-key
navigation and a CSV import wizard.

**No raw SQL and no DDL — structurally, not as a mode.** There is no endpoint
that runs a statement you supply, and none that creates, drops or alters a
table. Where the dashboard gated its write paths behind an environment flag, the
explorer's write surface is *bounded and enumerable* — the five method-qualified
keys in the table below — rather than switched on and off, so there is no flag to
leave set by accident and no second write path for a gate to miss.

It requires [`@bakery-framework/orm`](../orm/schema.md) as a real dependency: the
explorer browses the connection the application already opened, and opens
nothing of its own.

## Register

```ts
import { defineConfig } from '@bakery-framework/core'
import dbExplorerPlugin from '@bakery-framework/plugin-db-explorer'

export default defineConfig({
  root: 'src',
  plugins: [
    dbExplorerPlugin({
      // Decide who may browse, and what they may do. The explorer
      // authenticates nobody itself — your app already knows who its users
      // are. Return 'write', 'read', or false.
      authorize: req => (req.session.get('role') === 'admin' ? 'write' : false),
    }),
  ],
})
```

Options ([`db-explorer/src/index.ts`](../../packages/plugins/db-explorer/src/index.ts)):

| Option | Default | Meaning |
| --- | --- | --- |
| `authorize` | unset (admits nobody) | `(req: Request) => Access \| false \| Promise<Access \| false>`, where `Access` is `'read' \| 'write'`. |
| `users` | unset (admits nobody) | Named credentials, each with its own level. |
| `enabled` | `true` | `false` keeps the plugin out entirely — nothing is registered, no routes exist. |

There is no `credential` option. The explorer never had the dashboard's single
shared key: a key that admits also has to say *what it admits to*, which is what
`users` is.

## Access is a level, not a yes

`'read'` gets the grid with no edit affordances and a 403 from every write
endpoint. `'write'` gets the editor. Anything else the predicate returns —
**including `true`** — is a denial, because a predicate written against a boolean
API means "let them in" and cannot mean "let them write"
([`access.ts`](../../packages/plugins/db-explorer/src/access.ts)). Guessing which
was meant is exactly the mistake the level type exists to prevent, and admission
is the expensive direction to get wrong. A predicate that **throws** is a denial
too: indeterminate fails closed, the same convention the rest of the framework
follows.

The type is exported, so a predicate declared apart from the registration is
checked rather than inferred:

```ts
import type { AccessFn } from '@bakery-framework/plugin-db-explorer'

export const authorize: AccessFn = req => {
  const role = req.session.get('role')
  if (role === 'admin') return 'write'
  if (role === 'support') return 'read'
  return false
}
```

Named keys are the other door, for people and scripts with no session — an
on-call engineer with a key, a seeding job:

```ts
import dbExplorerPlugin from '@bakery-framework/plugin-db-explorer'

export const plugin = dbExplorerPlugin({
  users: {
    ops: { credential: process.env.OPS_KEY!, access: 'write' },
    oncall: { credential: process.env.ONCALL_KEY!, access: 'read' },
  },
})
```

They are named rather than a list because a log line saying *which* key was used
beats one saying "a key".

Present a key as an `x-db-key` header, as `Authorization: Bearer <key>`, or open
`/_db?db-key=<key>` once — the client moves it to `sessionStorage` and rewrites
the URL before anything else runs, so it does not stay in history, in a referrer
or in a screenshot. The compare is constant time, and an unset or empty
`credential` turns that entry **off**, never open. Every entry is compared with
no early exit: stopping at the first match would make the response time depend on
where in the map the matching key sits.

**The `?db-key=` form is refused on anything that changes state.** A credential
in a URL is what makes a cross-site write possible — the browser sends it because
it is in the link — and `checkCsrf` is an `Origin` check, not a token, so it
passes when `Origin` is absent or literally `"null"`, as it is from a sandboxed
iframe and some redirect chains. Requiring a header for writes means the caller
had to run script on this origin. `GET`, `HEAD` and `OPTIONS` still accept it.

`users` and `authorize` compose: **either admits, and the higher level wins**,
because they answer about the same caller — a session admin presenting a
read-only key is still an admin. Both doors are consulted even when the first
one admits. With neither configured the explorer admits nobody, which is the same
default it had when it was read-only, and the reason there is no `writes: true`
flag.

An unauthorised page request answers **404** — the explorer does not advertise
its existence — and an unauthorised `/api/_db/*` request answers **401**. Paths
ending `.css` or `.js` are exempt, so a denied response does not render
unstyled; they contain UI code, not data.

## Surface

`DbExplorerHandler` sits in the fetch registry at priority **115**, inside the
reserved `/_*` and `/api/_*` namespaces
([`setup.ts`](../../packages/plugins/db-explorer/src/setup.ts)).

| Request | Serves |
| --- | --- |
| `/_db` | the explorer shell |
| `/_db/app.js` | the compiled client — bundled on demand, cached in memory under `PROD` |
| `/api/_db/schema` | every table's columns, indexes, identity and `writable` + `reason`, plus the caller's own `access` |
| `/api/_db/table-data?tableName=…&page=…&pageSize=…&sortBy=…&sortOrder=…&filters=…` | one page of rows |
| `/api/_db/graph` | every foreign key, each table's identity, and a label column per table |
| `/api/_db/lookup` | foreign-key targets, batched — one query per table, never one per reference |
| `POST /api/_db/rows` | insert `{table, rows[], returning?}` → `{inserted, rows?}` |
| `PATCH /api/_db/row` | edit one `{table, key, set, expect, force?}` → `{changed, row}` |
| `POST /api/_db/rows/bulk` | edit many `{table, edits[], dryRun?}` → `{changed, conflicts}` |
| `DELETE /api/_db/rows` | delete `{table, keys[], expect?, dryRun?}` → `{deleted, conflicts}` |
| `POST /api/_db/import` | import `{table, rows[], onBadRow, dryRun?}` → `{inserted, skipped, errors}` |

Every `/api/_db/*` route answers with the standard JSON envelope.

**The key spellings are the CSRF policy.** `guardFor` in core's
[`plugins/routes.ts`](../../packages/core/src/plugins/routes.ts) reads the
distinction, so getting one wrong here loosens a guard silently rather than
failing anywhere visible:

- **Bare keys are the reads.** A bare key matches every method and gets
  `checkSameOrigin` on *all* of them, which is the stricter of the two: no
  cross-site page reaches these, whatever verb it uses.
- **Every write key names its method.** That pins the verb — a `GET
  /api/_db/rows` no longer resolves at all — and applies `checkCsrf`.

`/api/_db/graph` and `/api/_db/lookup` are reads despite one of them taking a
POST body, so they stay bare and take the stricter guard. Method-qualifying
`GET /api/_db/graph` would **weaken** it: a qualified GET passes `checkCsrf` by
definition.

## How a row is named

Every write addresses rows by a **declared key**, resolved per table by
[`identity.ts`](../../packages/plugins/db-explorer/src/identity.ts) in this
order:

1. the **primary key**, composite or not;
2. failing that, the **narrowest unique index whose every column is declared
   NOT NULL**, ties broken by index name so the choice does not depend on
   introspection order;
3. failing that, **nothing** — and the table is read-only for everybody,
   including a `write` caller. Every write against it answers 409, and
   `/api/_db/schema` says so per table with the reason, so the client knows
   before it draws an editable grid.

The NOT NULL condition is not fussiness: `NULL = NULL` is unknown, so a
predicate over a nullable unique column matches no row, and an UPDATE reporting
zero changes is indistinguishable from a conflict.

A **view** is always identity-less — it has no rows of its own to address. So is
a table whose name does not survive `qId`, the single SQL identifier writer,
which snake-cases before quoting: `qId('Orders')` emits `"orders"`, which on a
case-sensitive MySQL install is a statement against a different object or none at
all. Such a table is read-only deliberately; the alternative is writing to a
table the user did not name.

The key is transparent on the wire — `{ "id": 7 }`, or `{ "parcel_id": 1,
"leg_no": 2 }` for a composite one — and the server requires its column set to
**exactly equal** the identity. Not a subset, not a superset. A subset is a
predicate that matches more than one row.

Three things the explorer deliberately does **not** use, all of which the
dashboard's editor did:

- **`rowid`** — absent from a `WITHOUT ROWID` table, and not stable across a
  `VACUUM`.
- **`ctid`** — the *physical* location of a Postgres tuple. It moves on every
  UPDATE, so editing two rows of a page by the ctids the read returned edits
  whatever now sits in the second slot.
- **the first primary-key column** — on a composite key that predicate matches
  every row sharing it, so one edit rewrites all of them. Silently.

## Editing safely

### Three wire states, kept distinct

Most tools have one. The dashboard's editor read every cell as a string and let
the driver sort it out, so there was no way to say "leave this alone", an empty
text field cleared to NULL, and `""` into a numeric column silently became `0`.
Here ([`shared/coerce.ts`](../../packages/plugins/db-explorer/src/shared/coerce.ts)):

| On the wire | Means |
| --- | --- |
| key **absent** | leave the column unchanged — on an insert, let the database supply it |
| **`null`** | SQL NULL. Refused on a NOT NULL column rather than coerced |
| **`""`** | the empty string. A value on a text column; an error on any other kind — never NULL, never `0` |

`"007"` stays a string in a text column and becomes `7` in an integer one: the
**column** decides, not the shape of the characters. A number arriving for a text
column is refused for the same reason from the other side — it has already lost
its leading zeros. Integers go through `BigInt` before being narrowed, because
`Number('9007199254740993')` is a different integer from the one that was typed
and rounds silently.

### Optimistic concurrency

Every edit carries the **pre-image** of the columns it changes. `expect` is
appended to the identity predicate, so the statement is `identity ∧ expect`, and
the pre-image comes from the row as it was *read* — never from a re-read at save
time, which would defeat the check it exists to perform.

It is **required** on `PATCH /api/_db/row`; send `{}` to opt out explicitly, so
last-write-wins is never the silent default. On a bulk edit and on a delete it is
optional per entry.

A mismatch answers **409 with the row as it now stands**, which is what lets the
UI offer *keep mine / take theirs* rather than a "try again" button — retrying
against a row that moved is precisely how the other person's edit disappears.

`changed === 0` is **probed, not trusted.** MySQL reports zero changed rows for
an UPDATE that set every column to the value it already held, which is a
successful no-op and not a lost update. If the row still satisfies
`identity ∧ expect`, the answer is 200 `unchanged`; only a row that no longer
matches is a 409. The probe runs inside the same transaction as the UPDATE, or it
would be answering about a different moment. A DELETE needs no such probe: one
that matched a row always reports it.

`json` and `buffer` columns have no portable equality predicate — MySQL compares
JSON structurally, Postgres has no `=` for `json` at all, and a blob comparison
depends on how the driver bound the parameter. An `expect` on one is a 400, and
changing one needs `force: true`: an acknowledgement that this particular write
is unguarded, not a permission.

### Bounds

From [`policy.ts`](../../packages/plugins/db-explorer/src/policy.ts) — the size
at which a request stops being an edit and starts being a migration:

| Limit | Per request |
| --- | --- |
| rows in one insert | 1,000 |
| edits in one bulk edit | 1,000 |
| keys in one delete | 1,000 |
| rows in one CSV import | 50,000 |
| foreign-key targets in one lookup | 200 |

Over a bound is **413 with nothing executed** — not a truncation and not a
partial apply, because a caller told "1,000 inserted" out of 5,000 has no way to
know which 1,000 and the retry duplicates them. The check runs before validation,
so a 413 does not first cost the work of validating rows that were never going to
run.

### Validation accumulates

A 400 names **every** bad field as `{row, column, code, message}`, and nothing is
applied. Fixing a fifty-row paste one error per round trip is fifty round trips,
and the user never sees the shape of their mistake. An unknown column is an error
rather than a dropped key: a typo'd column that reports success is a row the user
believes they changed and did not.

### Transactions and dry runs

Bulk edit, delete and import each run in **one transaction**. A single conflict
rolls the whole thing back with a 409 listing them — a bulk edit is one action
from the user's side, and a partial apply leaves them with no way to know which
half landed.

`dryRun: true` on those three **executes the statements and then rolls back**, so
the count it reports reflects what the database actually did with its own
constraints rather than a guess about them. That is worth knowing about because
it is a workaround: `SQLAdapter.transaction()` commits on return and rolls back
on throw, with no third outcome, so the report rides out on a deliberate
exception
([`preview.ts`](../../packages/plugins/db-explorer/src/preview.ts)). `POST
/api/_db/rows` has no `dryRun` — an insert has no pre-existing rows to be wrong
about.

> `returning: true` on an insert needs a dialect with `RETURNING`: SQLite and
> Postgres have it, MySQL does not and answers with its own syntax error. It is
> not emulated, because a re-SELECT would have to guess which rows were just
> written.

## The interface

The layout is the one a database client is expected to have: a table list, a
strip of table tabs, one view under it, and a status bar. What is deliberately
absent, and is not anywhere: a SQL console, an ER diagram, and grid
virtualisation.

**Tabs have preview semantics**, VS Code's and Supabase Studio's
([`client/tabs.ts`](../../packages/plugins/db-explorer/src/client/tabs.ts)). A
single click in the sidebar opens an italic *preview* tab which the next single
click replaces in place, so browsing twelve tables leaves one tab open rather
than twelve. Double-clicking makes it permanent, and so does editing anything in
it — investment promotes a tab, merely looking at it does not. A table that is
already open is *selected* rather than reopened, with its page, sort and filters
untouched; that restoration is the property that makes tabs worth having. The
whole tab set lives in the URL **hash**, which never reaches the server and is
not the query string the `?db-key=` scrub rewrites.

**Each table has three views** — Data, Structure and Relations. One level of
nesting, and only one.

- **Structure** is the type, nullability, default, enum members,
  auto-increment flag, declared indexes and resolved row identity of every
  column. All of it was already in `/api/_db/schema` and the old client used it
  only to pick an editor widget; the reason a table is read-only was the worst of
  the omissions, since it existed in the server's own words and appeared nowhere.
- **Relations** lists foreign keys in both directions — what this table points
  at, and what points back — both clickable, because "which tables reference this
  one" is the question you ask before deleting anything.

**Filters are built, not typed into a box per column.** A filter is column +
operator + value, each chip removable
([`shared/filters.ts`](../../packages/plugins/db-explorer/src/shared/filters.ts)):

| Operator | Reads as |
| --- | --- |
| `eq` `ne` | `=` `≠` |
| `gt` `gte` `lt` `lte` | `>` `≥` `<` `≤` |
| `contains` `starts` `ends` | substring, prefix, suffix |
| `null` `notnull` | `IS NULL`, `IS NOT NULL` — these bind nothing, so the value input is *hidden* rather than ignored |

The three pattern operators escape `%` and `_` in the value before it reaches
the pattern, with `ESCAPE '!'` on the clause — so a filter for `50%` finds the
literal percent sign rather than matching every row, and `a_b` does not match
`axb`. `!` rather than a backslash, because MySQL processes backslash escapes
inside string literals and the Postgres normalizer applies that rule to every
dialect: `ESCAPE '\'` leaves the literal open and the driver reports a syntax
error several tokens further on.

The vocabulary is shared with the endpoint that validates it, and an unknown
operator is a **400 rather than a dropped clause**. That direction matters: the
ORM drops an operator it does not know, a dropped filter *widens* the result set,
and the explorer's Delete acts on a selection made from exactly that view. A bare
scalar still means `contains`, which is what every caller sent before operators
existed.

`eq` is also what retired the old row-focus machinery. A foreign-key jump used to
need a row identity carried alongside the filters, because a substring `LIKE`
could not name a row — `id=1` matched `11`. It is now an ordinary filter.

**Inline edit is double-click, and blur *stages* rather than saves.** The only
things that commit are Enter, Tab and the row's own Save button
([`client/cell.ts`](../../packages/plugins/db-explorer/src/client/cell.ts)). The
dashboard saved on blur, so a stray click into another cell was a write and a
three-column edit was three statements with two moments in between where the row
was half-updated. **A row saves as one statement** carrying every changed column
and its pre-image; unchanged columns are dropped from the `set`, so two people
editing different columns of one row do not collide.

**The row side panel** is the same editors and the same edit session as the grid,
in a form: one Save covers both. It is what a forty-column row needs — editing
one in the grid means scrolling past thirty-nine others, and a `json` column gets
a cell six characters tall. It adds textareas for long text and JSON, and both
directions of the graph, with *referenced by* loaded lazily per section rather
than per visible row.

**The status bar** answers three things that otherwise need a trip through the
developer tools: how many rows there really are, how long the server took, and
whether this session can write at all. The access level used to be a line of
sidebar text that scrolled away.

**System tables are hidden behind a checkbox**, not removed. Anything matching
the reserved `__bakery` prefix — the ORM's own sync ledger — is the framework's
bookkeeping rather than the user's data, but a ledger row is occasionally exactly
what someone needs to see, and a table that cannot be reached at all is a support
question. The count is in the checkbox's label, so it says what it would do
before it is clicked.

**Destructive actions get friction proportional to how many rows they touch**
([`client/confirm.ts`](../../packages/plugins/db-explorer/src/client/confirm.ts)):

| Rows | Ceremony |
| --- | --- |
| ≤ 1 | immediate, with an undo — a dialog per row makes the tool unusable for the thing it is for |
| 2 – 100 | a dialog naming the count and what changes |
| 101 – 10,000 | the same, plus typing the table name |
| > 10,000 | **refused.** There is no phrasing of "are you sure" that makes a ten-thousand-row unreviewed write a good idea; narrow it with a filter |

**The count fed to that ladder comes from a `dryRun`, never from the page.** A
selection of eight checkboxes on a filtered page can delete eight rows or, if the
keys were built from something wider, rather more. The server's own preview is
the only number that is the number.

## CSV import

Pick → sniff → map → preview → commit
([`client/csv.ts`](../../packages/plugins/db-explorer/src/client/csv.ts)). The
parse, the coercion and the mapping run in `shared/`, which is the same code the
server runs — the only way the preview and the outcome agree.

- **Delimiter and header row are sniffed and both overridable** (comma,
  semicolon, tab, pipe).
- **Per-column mapping**, auto-matched by exact name first and then
  case- and separator-insensitively, so `Courier Name`, `courier_name` and
  `courierName` all find `courier_name`. Nothing fuzzier: a near-miss that
  silently loads the wrong column is worse than an unmapped one the dialog can
  ask about. A database column is claimed at most once, and re-picking *moves* a
  column rather than duplicating it.
- **Constants.** A column can be fed a literal on every row instead of a CSV
  field.
- **An empty-→-NULL toggle per column**, defaulted on for every kind except
  text — which is the three-wire-state rule surfaced as a checkbox, since `""`
  is a real value for text and an error for everything else.
- **A bad-row policy**: *skip bad rows and report*, *stop at the first bad row*,
  or *all or nothing* (which sends the file as a single request rather than in
  chunks, so the transaction covers all of it). The endpoint's own `onBadRow`
  must be `'stop'` or `'skip'` explicitly — it is not defaulted, because the two
  answers differ in whether a partially-good file gets partially imported and
  that is the one decision the caller must have made on purpose.
- **A rejected-rows download.** What failed comes back as a CSV you can fix and
  re-import.

An unmapped NOT NULL column with no default **blocks the import** before a
statement runs, rather than failing every row one at a time after it has started.
Sending is chunked, and Cancel stops **before the next request** rather than
aborting one in flight — so the answer to "what landed" is exact.

## What it refuses, structurally

- **No raw SQL.** There is no endpoint that runs a statement you supply.
- **No DDL.** Nothing creates, drops, alters or truncates a table.
- **No writing to a table whose rows cannot be named**, whatever the caller's
  access level.
- **No credential in a URL on a state-changing request.**

None of these is a mode, a flag or a setting. There is no such path.

## Production checklist

- Pass `enabled: false`, or an `authorize` predicate and a `users` map you can
  defend. Registering with neither leaves the explorer reachable by nobody, which
  is safe but is not a plan.
- Grant `'read'` where `'read'` is enough. It is a real level, not a hint: every
  write endpoint checks it before the request body is even parsed.
- Keep keys out of links. Use `x-db-key` or a Bearer token for anything
  automated; `?db-key=` exists for a human opening a URL once, and it will not
  work for a write.
- Remember that the explorer runs at the same origin as the application, so an
  XSS anywhere in that origin inherits whatever access the caller has.
