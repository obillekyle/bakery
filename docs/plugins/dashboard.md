# Dashboard plugin

`@bakery/plugin-dashboard` serves an admin console at `/_dashboard`: server
metrics, live logs, a session browser and editor, and a database browser with a
SQL console.

**The dashboard does not authenticate anyone.** It takes a predicate from the
application, which already knows who its users are. The old shared-secret
scheme — `DASHPASS`, HTTP Basic auth, a login form, a session flag, a
constant-time compare and a failed-attempt backoff map — is gone, not
deprecated. The `renderLoginForm` component outlived the flow as dead code
for a while; it is gone now too.

## Register

```ts
import { defineConfig } from '@bakery/core'
import dashboardPlugin from '@bakery/plugin-dashboard'

export default defineConfig({
  root: 'src',
  plugins: [
    dashboardPlugin({
      authorize: req => req.session.get('role') === 'admin',
    }),
  ],
})
```

Options ([`dashboard/src/index.ts`](../../packages/plugins/dashboard/src/index.ts)):

| Option | Default | Meaning |
| --- | --- | --- |
| `authorize` | see below | `(req: Request) => boolean \| Promise<boolean>`. Return `true` to allow. |
| `enabled` | `true` | `false` keeps the plugin out entirely — nothing is registered, no routes exist. The documented way to disable it in production. |

## The default is closed

With no `authorize` supplied
([`dashboard/src/authorize.ts`](../../packages/plugins/dashboard/src/authorize.ts)):

```ts no-check — the default predicate, quoted; supply your own instead
export function defaultAuthorize(req: Request): boolean {
  if (!import.meta.env.DEV) return false
  return isLoopback(req)
}
```

- **Development**: allowed from loopback only — `127.0.0.1`, `::1`, or a
  request whose hostname is `localhost`. The client IP is read through
  `getClientIp`, and if that throws (no config, early boot) the hostname alone
  decides.
- **Production**: denied, always. Forgetting to configure the console cannot
  expose a database browser to the internet.

The predicate runs inside `isAuthorized`, which coerces the result and treats a
**throw as a denial**. An authorization check that errors is indeterminate, and
indeterminate fails closed — the same guard convention the rest of the
framework follows. A predicate that returns `undefined` is not trusted either.

Because the predicate receives the raw `Request`, it composes with whatever the
application already has: a session role, a signed cookie, an IP allow-list, an
upstream header. It can be async.

```ts
import dashboardPlugin from '@bakery/plugin-dashboard'

export const plugin = dashboardPlugin({
  authorize: async req => {
    const userId = req.session.get('userId')
    if (!userId) return false
    return await isAdmin(userId)
  },
})

declare function isAdmin(id: string): Promise<boolean>
```

The bundled example app uses `authorize: () => true`
([`apps/example/server.config.ts`](../../apps/example/server.config.ts)) —
appropriate for a local demo, and nothing else.

## Routes

`DashboardHandler` sits in the fetch registry at priority **120**, above
everything else, so it sees these paths first.

| Route | Serves |
| --- | --- |
| `/_dashboard` | the console shell (server-rendered JSX) |
| `/_dashboard/dashboard.js` | the client bundle, built on demand and cached |
| `/_dashboard/style.css` | the stylesheet, served through a route mount |
| `/api/_dashboard/sessions` | list sessions (`search`, `page`, `pageSize`, `sortBy`, `sortOrder`) |
| `/api/_dashboard/sessions/delete` | delete one by id |
| `/api/_dashboard/sessions/update` | set or remove one key on one session |
| `/api/_dashboard/schema` | the live database schema |
| `/api/_dashboard/table-data` | paged rows for one table (`tableName`, `page`, `pageSize`, `sortBy`, `sortOrder`, `filters`) |
| `/api/_dashboard/query` | run SQL |
| `/api/_dashboard/execute-action` | row-level actions: `delete-row`, `insert-row`, `update-row`, `truncate`, `import-csv` |

Every `/api/_dashboard/*` route answers with the standard JSON envelope; the
shell is a `Response` and `dashboard.js` is a `Bun.BunFile` once cached, which
is why the plugin's response type is a three-member union rather than
`Response`.

Unauthorized requests get **404** for page routes and **401** for `/api/`
routes ([`dashboard/src/setup.ts`](../../packages/plugins/dashboard/src/setup.ts)).
Any path ending `.css` or `.js` is deliberately exempt from the check — they
are not secrets, and letting them through keeps a denied response from
rendering unstyled. Note what that means concretely: `/_dashboard/style.css`
and `/_dashboard/dashboard.js` are readable by anyone while the plugin is
enabled. They contain UI code, not data.

### The route mount

The stylesheet is not served by a bespoke asset route. `setup()` calls
`mountRoutes('/_dashboard', <plugin>/public)`, and the normal static pipeline
takes it from there — with the mount directory as the containment boundary
([`dashboard/src/setup.ts`](../../packages/plugins/dashboard/src/setup.ts)).

This is why `DashboardHandler.canHandle` is written so narrowly: it claims
`/api/_dashboard*`, `/_dashboard` and `/_dashboard/dashboard.js`, and nothing
else. A handler at priority 120 that claimed `/_dashboard/*` would intercept
every asset before the mount was ever consulted.

## The SQL console

`/api/_dashboard/query` is a real SQL prompt against the application's
database. Three guards sit on it
([`dashboard/src/endpoints/database.ts`](../../packages/plugins/dashboard/src/endpoints/database.ts)):

1. **Reads only, by default.** A statement that does not begin with `SELECT`,
   `WITH`, `SHOW`, `DESCRIBE`, `PRAGMA` or `EXPLAIN` is rejected with 403
   unless the environment sets `DASHBOARD_ALLOW_WRITES=1`. A browser console
   should not be a one-keystroke path to `DROP TABLE` in production.

   The same flag now gates the **grid editor** too — row insert, update and
   delete, and table truncate. It previously covered only the SQL console, so
   the Truncate button was exactly the one-keystroke path that rule describes.
   A control covering one of two routes to the same effect is worse than none,
   because it reads as protection.
2. **`ATTACH` / `DETACH` / `VACUUM INTO` are always rejected**, write mode or
   not. In SQLite, `ATTACH` plus `VACUUM INTO` is an arbitrary file write —
   which would turn any dashboard session, or any XSS in this origin, into host
   filesystem access.
3. **Table names are validated** against `^[a-zA-Z0-9_]+$` before reaching any
   query builder.

Session editing has its own guard: a key under the reserved `__bakery.` prefix
is rejected with 403. Without it, editing a session could set a framework
privilege marker on any user's session — a permanent backdoor
([`dashboard/src/endpoints/sessions.ts`](../../packages/plugins/dashboard/src/endpoints/sessions.ts)).

## Live logs

`setup()` installs a log callback that broadcasts every log entry as JSON to
the `connectedLoggers` set, which the core live-reload WebSocket handler
populates. The callback returns early when nothing is connected, so an
unwatched server does not pay for a `JSON.stringify` per log line.

The Logs panel is therefore **development-only in practice**:
`LiveReloadHandler` refuses to handle `/_livereload` unless both `DEV` and
`DEV_WORKER` are set, so in production nothing ever joins the registry.

## Known issue: the Overview panel cannot load

The stats panel talks to the analytics plugin over `/_analytics_ws` and
`/api/_analytics/reset`, by **hardcoded URL** — the package dependency was
removed but the coupling moved into strings, invisible to both the dependency
graph and the typechecker
([`dashboard/src/client/parts/stats.ts,644`](../../packages/plugins/dashboard/src/client/parts/stats.ts)).

Two things follow:

- Install the dashboard **without** `@bakery/plugin-analytics` and those calls
  404 silently. The panel stays empty; nothing reports why.
- Install it **with** analytics and they are refused anyway, because the
  analytics authorization check can no longer be satisfied by anything in the
  repository. See
  [Analytics → Authorization is currently a dead end](analytics.md#authorization-is-currently-a-dead-end).

The Sessions, Database and Logs panels are unaffected — they use
`/api/_dashboard/*`, which is gated by your `authorize` predicate and works.

## Production checklist

- Pass `enabled: false`, or an `authorize` predicate you can defend. There is
  no third option that leaves the console reachable safely.
- Leave `DASHBOARD_ALLOW_WRITES` unset.
- Remember that the console runs at the same origin as the application, so an
  XSS anywhere in that origin inherits whatever the predicate grants.
