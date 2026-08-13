# Database explorer plugin

`@bakery-framework/plugin-db-explorer` serves a database browser and editor at
`/_db`: the table list, rows with paging and sorting, row edits, CSV import and
foreign-key navigation.

**No raw SQL and no DDL — structurally, not as a mode.** There is no endpoint
that runs a statement you supply, and none that creates, drops or alters a
table. What CRUD changed is row data. Where the dashboard gates its write paths
behind `DASHBOARD_ALLOW_WRITES`, the explorer's write surface is *bounded and
enumerable* — the six keys in the table below — rather than switched on and off,
so there is no flag to leave set by accident and no second write path for a gate
to miss.

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
      authorize: req =>
        req.headers.get('x-operator') === 'on-call' ? 'read' : false,
    }),
  ],
})
```

**Access is a level, not a yes.** `'read'` gets the grid with no edit
affordances and a 403 from every write endpoint; `'write'` gets the editor.
Anything else the predicate returns — including `true` — is a denial, because a
predicate written against a boolean API means "let them in" and cannot mean
"let them write".

Named keys are the other door, for people and scripts with no session:

```ts no-check — import.meta.env keys are app-defined
dbExplorerPlugin({
  users: {
    ops: { credential: import.meta.env.OPS_KEY, access: 'write' },
    oncall: { credential: import.meta.env.ONCALL_KEY, access: 'read' },
  },
})
```

Present a key as `Authorization: Bearer <key>`, an `x-db-key` header, or open
`/_db?db-key=<key>` once — the client stores it for its API calls and strips it
from the URL. Compared in constant time; an unset or empty credential turns
that entry **off**, never open. **The `?db-key=` form is refused on writes** —
a credential in a URL travels with any link, and `checkCsrf` is an `Origin`
check that passes when `Origin` is absent.

`users` and `authorize` compose: either admits, and the **higher** level wins,
because they answer about the same caller. With neither configured the explorer
admits nobody.

An unauthorised page request answers 404 (the explorer does not advertise its
existence); an unauthorised `/api/_db/*` request answers 401.

## Surface

| Request | Serves |
| --- | --- |
| `/_db` | the explorer UI |
| `/_db/app.js` | the compiled client |
| `/api/_db/schema` | the schema, the caller's `access`, and per table `writable` + `reason` |
| `/api/_db/table-data?tableName=…&page=…&pageSize=…&sortBy=…&sortOrder=…` | one page of rows |
| `/api/_db/graph` | every foreign key, each table's identity, and a label column per table |
| `/api/_db/lookup` | foreign-key targets, batched — one query per table, never one per reference |
| `POST /api/_db/rows` | insert `{table, rows[], returning?}` → `{inserted, rows?}` |
| `PATCH /api/_db/row` | edit one `{table, key, set, expect, force?}` → `{changed, row}` |
| `POST /api/_db/rows/bulk` | edit many `{table, edits[], dryRun?}` → `{changed, conflicts}` |
| `DELETE /api/_db/rows` | delete `{table, keys[], expect?, dryRun?}` → `{deleted, conflicts}` |
| `POST /api/_db/import` | import `{table, rows[], onBadRow, dryRun?}` → `{inserted, skipped, errors}` |

The read keys are deliberately **method-unqualified** and the write keys are
**method-qualified**, which is not cosmetic: `guardFor` in core's
`plugins/routes.ts` reads that distinction. A bare key gets `checkSameOrigin` on
*every* method, which is the stricter guard; a qualified key pins the verb and
gets `checkCsrf`. `graph` and `lookup` are reads and stay bare even though one
of them takes a POST body — qualifying `GET /api/_db/graph` would *weaken* it,
since a qualified GET passes `checkCsrf` by definition.

Requires `@bakery-framework/orm` — the explorer browses the connection the
app already opened. Registered at priority **115**, inside the reserved
`/_*` and `/api/_*` namespaces.

## How a row is named

Every write addresses rows by a **declared key**: the primary key, or failing
that the narrowest unique index whose every column is `NOT NULL`. A table with
neither is **read-only for everybody** — every write answers 409 — because there
is no way to name one of its rows, and `/api/_db/schema` says so per table so
the client knows before it renders.

The key is transparent on the wire — `{ "id": 7 }`, or `{ "parcel_id": 1,
"leg_no": 2 }` for a composite one — and the server requires its column set to
**exactly equal** the identity. Not a subset, not a superset. A subset is a
predicate that matches more than one row.

Three things the explorer deliberately does **not** use, all of which the
dashboard does:

- **`rowid`** — absent from a `WITHOUT ROWID` table, and not stable across a
  `VACUUM`.
- **`ctid`** — the *physical* location of a Postgres tuple. It moves on every
  UPDATE, so editing two rows of a page by the ctids the read returned edits
  whatever now sits in the second slot.
- **the first primary-key column** — on a composite key that predicate matches
  every row sharing it, so one edit rewrites all of them. Silently.

## Editing safely

**Three wire states, kept distinct.** A key that is **absent** leaves the column
unchanged; JSON **`null`** is SQL NULL and is refused on a `NOT NULL` column;
**`""`** is the empty string — never NULL, and never `0`. `"007"` stays a string
in a text column and becomes `7` in an integer one: the column decides, not the
shape of the characters.

**Optimistic concurrency.** `expect` carries the values the editor last saw and
is appended to the identity predicate. It is **required** on `PATCH` — send `{}`
to opt out explicitly — so last-write-wins is never the silent default. A
mismatch answers 409 with the row as it now stands.

`json` and `buffer` columns have no portable equality predicate (MySQL compares
JSON structurally, Postgres has no `=` for `json`), so `expect` on one is a 400
and changing one needs `force: true` — an acknowledgement that the write is
unguarded, not a permission.

**Bounds.** 1,000 rows per insert, 1,000 edits per bulk, 1,000 keys per delete,
50,000 rows per import, 200 references per lookup. Over a bound is **413 with
nothing executed** — not a truncation and not a partial apply, because a caller
told "1,000 inserted" out of 5,000 has no way to know which 1,000 and the retry
duplicates them.

**Validation accumulates.** A 400 names every bad field as
`{row, column, code, message}`, and nothing is applied. An unknown column is an
error rather than a dropped key: a typo'd column that reports success is a row
the user believes they changed and did not.

**Bulk edit and delete are all-or-nothing.** They run in one transaction, and a
single conflict rolls the whole thing back with a 409 listing them. `dryRun`
runs the statements — so the report reflects what the database actually did with
its own constraints — and then rolls back.

> `returning: true` on an insert needs a dialect with `RETURNING`: SQLite and
> Postgres have it, MySQL does not and answers with its own syntax error. It is
> not emulated, because a re-SELECT would have to guess which rows were just
> written.
