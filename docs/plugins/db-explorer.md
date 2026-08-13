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
| `/api/_db/schema` | the schema, from the ORM connection |
| `/api/_db/table-data?tableName=…&page=…&pageSize=…&sortBy=…&sortOrder=…` | one page of rows |

Requires `@bakery-framework/orm` — the explorer browses the connection the
app already opened. Registered at priority **115**, inside the reserved
`/_*` and `/api/_*` namespaces.
