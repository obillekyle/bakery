# Database explorer plugin

`@bakery-framework/plugin-db-explorer` serves a read-only database browser at
`/_db`: the table list, rows with paging and sorting, and nothing else.

**Read-only is the contract, not a mode.** There is no raw-SQL endpoint, no
row mutation, and no DDL. Where the dashboard gates its write paths behind
`DASHBOARD_ALLOW_WRITES`, the explorer has no write paths to gate — removing
the paths is a stronger property than gating them, because there is no flag
to leave set by accident and no second write path for a gate to miss.

## Register

```ts
import { defineConfig } from '@bakery-framework/core'
import dbExplorerPlugin from '@bakery-framework/plugin-db-explorer'

export default defineConfig({
  root: 'src',
  plugins: [
    dbExplorerPlugin({
      // Decide who may browse. The explorer authenticates nobody itself —
      // your app already knows who its users are.
      authorize: req => req.headers.get('x-operator') === 'on-call',
    }),
  ],
})
```

Omit `authorize` and access is **loopback-only in development and denied in
production** — an unconfigured explorer is never exposed. The loopback check
uses the peer address, never the `Host` header, for the same reason the
dashboard's does: a header is evidence the client chooses.

A shared key is the lighter alternative for a team without user roles:

```ts no-check — import.meta.env keys are app-defined
dbExplorerPlugin({ credential: import.meta.env.DB_EXPLORER_KEY })
```

Present it as `Authorization: Bearer <key>`, an `x-db-key` header, or open
`/_db?key=<key>` once — the client stores it for its API calls and strips it
from the URL. Compared in constant time; an unset or empty variable turns the
path **off**, never open. `credential` and `authorize` compose: either
admits.

An unauthorised page request answers 404 (the explorer does not advertise its
existence); an unauthorised `/api/_db/*` request answers 401.

## Surface

| Request | Serves |
| --- | --- |
| `/_db` | the explorer UI |
| `/_db/app.js` | the compiled client |
| `/api/_db/schema` | the schema, from the ORM connection |
| `/api/_db/table-data?tableName=…&page=…&pageSize=…&sortBy=…&sortOrder=…` | one page of rows |

Requires `@bakery-framework/orm` — the explorer browses the connection the
app already opened. Registered at priority **115**, inside the reserved
`/_*` and `/api/_*` namespaces.
