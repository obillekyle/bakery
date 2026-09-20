# Upgrading from 1.2 to 2.0

Nine breaking changes, grouped by what has to happen to your code. Most apps
are touched by two or three of them; a catch-all route is the one nearly
everybody hits.

Nothing here is a rename you can find and replace. Each section says what
changed, how it shows up if you do nothing, and what to write instead.

## The short version

| If your app | Read |
| --- | --- |
| has any `[...slug]` page | [Catch-alls bind arrays](#catch-alls-bind-arrays) |
| sets `DASHPASS` | [DASHPASS is gone](#dashpass-is-gone) |
| registers the dashboard | [One door, and it is analytics'](#one-door-and-it-is-analytics) |
| edited data through the console | [The console no longer edits your database](#the-console-no-longer-edits-your-database) |
| uses the database explorer | [Explorer access is a level](#explorer-access-is-a-level) |
| calls `session.bind(res)` | [`session.bind` is gone](#sessionbind-is-gone) |
| calls `recordDbHit` | [DB Hits is gone](#db-hits-is-gone) |
| reads `Bakery.sharedPool.dataPool` | [The shared pool lost its scratch region](#the-shared-pool-lost-its-scratch-region) |
| imports from a deep `@bakery-framework/core` path | [Four export aliases closed](#four-export-aliases-closed) |

## Catch-alls bind arrays

**The one most apps hit.** A catch-all parameter used to arrive as a joined
string; it is an array of segments now.

```ts no-check: the 1.2 form, shown for comparison
export default html<{ page: string }>((req, body) => {
  const crumbs = body.page.split('/')
  return `<h1>${crumbs.at(-1)}</h1>`
})
```

```ts no-check: the 2.0 form
export default html<{ page: string[] }>((req, body) => {
  const crumbs = body.page
  return `<h1>${crumbs.at(-1)}</h1>`
})
```

**How it shows up if you do nothing:** a 500 on every request to that page,
because `.split` is not a function on an array. The type changed too, so
`bun run typecheck` catches it before you ship if your page declares its
params.

`[...slug!]` is new alongside it: the trailing `!` makes a catch-all claim its
own bare directory as well as everything under it. Without it, `/docs` and
`/docs/a/b` need two files.

## DASHPASS is gone

The environment variable is read nowhere. It never granted access in the first
place. It changed a status code, and the analytics stats endpoint was the
last thing that looked at it.

**Delete it from every environment that still sets it.** A variable that looks
like a credential and controls nothing is the kind of leftover an operator
reasons from.

What replaces it is configuration rather than environment:

```ts
import { defineConfig } from '@bakery-framework/core'
import analyticsPlugin from '@bakery-framework/plugin-analytics'

export default defineConfig({
  plugins: [
    analyticsPlugin({
      credential: process.env.ANALYTICS_KEY,
      // or your own predicate
      authorize: (req: Request) => req.headers.get('x-role') === 'admin',
    }),
  ],
})
```

With neither configured, the guard allows loopback in development and denies
everything in production. **The closed state is the default**, so an
unconfigured app is not an open one.

## One door, and it is analytics'

The dashboard does not authenticate anybody itself. It hands its `authorize`
predicate to the analytics plugin, which owns the decision for both, so
whatever admits you to the console admits you to the data it renders.

```ts
import { defineConfig } from '@bakery-framework/core'
import dashboardPlugin from '@bakery-framework/plugin-dashboard'

export default defineConfig({
  plugins: [
    dashboardPlugin({
      authorize: (req: Request) => req.headers.get('x-role') === 'admin',
    }),
  ],
})
```

**How it shows up if you do nothing:** in development, nothing. Loopback is
allowed. In production the console is closed, which is the intended default
and may be a surprise if you were relying on `DASHPASS` to open it.

One related fix worth knowing if you wrote a predicate that returns something
other than a boolean: a truthy non-boolean no longer grants access. `authorize`
must return `true`.

## The console no longer edits your database

The dashboard's grid editor and its raw SQL prompt are gone, along with the two
endpoints behind them. `@bakery-framework/plugin-db-explorer` does the same
work at `/_db` with a proper access model.

If the explorer is registered, the console's Database entry links to it. If it
is not, the entry is a panel saying where the editor went.

**Also removed in 2.0**, for the same reason that it never worked: the
console's session **key editor**. The Edit and Add Key buttons built a dialog
that no rule in the stylesheet could show, so they had no effect in any release
that shipped them. Listing sessions, revoking one and deleting a key all still
work.

## Explorer access is a level

`@bakery-framework/plugin-db-explorer` does not share the dashboard's door, and
configuring the dashboard grants nothing there. Access is a **level per
caller** rather than a yes:

```ts
import { defineConfig } from '@bakery-framework/core'
import dbExplorerPlugin from '@bakery-framework/plugin-db-explorer'

export default defineConfig({
  plugins: [
    dbExplorerPlugin({
      users: {
        ops: { credential: process.env.DB_KEY ?? '', access: 'write' },
        support: { credential: process.env.SUPPORT_KEY ?? '', access: 'read' },
      },
    }),
  ],
})
```

`users` is keyed by a name, which is there so a log line can say *which* key
was used rather than that a key was. `access` is validated at boot now: a value
that is not a level throws when the plugin is registered, instead of being
echoed back to the client as though it meant something.

With no `users` and no predicate, the explorer allows loopback in development
and denies everything in production.

## `session.bind` is gone

The instance method did nothing. If you wrote:

```ts no-check: the 1.2 form, which had no effect
session.bind(response)
```

delete the line. Nothing replaces it: a session cookie is attached by the
framework on the way out, and always was. `Session.bind` the static is
unrelated and stays.

## DB Hits is gone

`recordDbHit` is no longer exported from
`@bakery-framework/plugin-analytics`, and the DB Hits chart is gone from the
console.

Nothing could ever call it. The ORM cannot import a plugin, so there was no
path from a query to the counter, and the chart read zero in every release that
shipped it. If you want to count your own database work, keep your own counter
and expose it on your own route.

## The shared pool lost its scratch region

`Bakery.sharedPool.dataPool` no longer exists, and the pool's default
allocation is its own layout rather than a megabyte.

Nothing read the region. It was 99% of the allocation, and its only consumer
anywhere was a test asserting its type. The header, the counters and the
rate-limit slots are unchanged, and a larger buffer is still accepted if you
ask for one.

## Four export aliases closed

These four subpaths of `@bakery-framework/core` are gone, each a duplicate of
something that stays:

| Removed | Use |
| --- | --- |
| `@bakery-framework/core/core` | `@bakery-framework/core` |
| `@bakery-framework/core/jsx` | `@bakery-framework/core` |
| `@bakery-framework/core/core/jsx` | `@bakery-framework/core` |
| `@bakery-framework/core/utils/isomorphic` | `@bakery-framework/core/utils` |

**How it shows up if you do nothing:** a module resolution error at import, so
you will not ship it by accident.

## After upgrading

Run `bun run typecheck`. Three of the nine changes above are visible to the
compiler: the catch-all parameter type, the removed `session.bind`, and the
closed export aliases. It will name most of what needs touching.

Then request a page. The other seven are runtime behavior, and a server that
boots is not a page that works.
