# Dashboard plugin

`@bakery-framework/plugin-dashboard` serves an admin console at `/_dashboard`: server
metrics, live logs, and a session browser and editor.

**It no longer edits your database.** The grid editor and the raw SQL console
that used to live in the Database tab are gone, along with the
`DASHBOARD_ALLOW_WRITES` flag that gated them —
[`@bakery-framework/plugin-db-explorer`](db-explorer.md) does that work at
`/_db` with a per-caller access level instead of one process-wide environment
variable. The console's Database entry is a link to it when it is mounted, and
a panel saying where it went when it is not.

**The dashboard does not authenticate anyone.** It takes a predicate from the
application, which already knows who its users are. The old shared-secret
scheme — `DASHPASS`, HTTP Basic auth, a login form, a session flag, a
constant-time compare and a failed-attempt backoff map — is gone, not
deprecated. The `renderLoginForm` component outlived the flow as dead code
for a while; it is gone now too.

## Register

```ts
import { defineConfig } from '@bakery-framework/core'
import dashboardPlugin from '@bakery-framework/plugin-dashboard'

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
| `credential` | unset (off) | A shared key, presented as `Authorization: Bearer`, `x-analytics-key`, or `?analytics-key=`. Composes with `authorize`: either admits. |
| `enabled` | `true` | `false` keeps the plugin out entirely — nothing is registered, no routes exist. The documented way to disable it in production. |

## The door belongs to analytics

[`@bakery-framework/plugin-analytics`](analytics.md) is a **hard dependency**
of this package, not an optional companion. The console renders analytics, its
client calls `/api/_analytics/reset` and opens the `/_analytics_ws` socket, and
registering the dashboard brings analytics' handlers up so those endpoints
exist.

It follows that they share one door rather than two. `dashboardPlugin`
forwards both `authorize` and `credential` to `setupAnalytics`, and the
console's request guard *is* `isAnalyticsAuthorized` — the analytics key is
literally the dashboard key. A console admitted by one key while the data it
renders answered to another would be half-open by construction.

```ts no-check — import.meta.env keys are app-defined
dashboardPlugin({ credential: import.meta.env.ANALYTICS_KEY })
```

Configure it on either plugin. A call that omits an option leaves whatever the
other one set, so registration order does not decide the answer; to turn a
door off, pass the empty string or do not register the plugin.

## The default is closed

With no `authorize` supplied, `setupDashboard` forwards core's
`defaultAuthorize`
([`core/src/utils/http/authorize.ts`](../../packages/core/src/utils/http/authorize.ts)):

```ts no-check — the default predicate, quoted; supply your own instead
export function defaultAuthorize(req: Request): boolean {
  if (import.meta.env.PROD !== false) return false
  return isLoopback(req)
}
```

- **Development**: allowed from loopback only — `127.0.0.1`, `::1` or
  `::ffff:127.0.0.1`, read from the peer address through `getClientIp`. Never
  a hostname: `Host: localhost` is chosen by the client, and honouring it once
  meant any peer on the LAN could ask for a database browser.
- **Production**: denied, always. The gate reads `PROD` rather than `!DEV`, and
  an *unset* flag counts as production — so a process that never booted through
  `core/init` is closed too. Forgetting to configure the console cannot put it
  on the internet.

This is the one place the console is not simply analytics': analytics on its
own is closed until configured, and forwarding `defaultAuthorize` keeps the
loopback-in-development convenience that a scaffolded `dashboardPlugin()`
relies on. It can only ever narrow — it denies in production and admits
nothing but this machine in development.

The predicate runs behind `isAuthorized`, which requires the exact boolean
`true` and treats a **throw as a denial**. An authorization check that errors
is indeterminate, and indeterminate fails closed — the same guard convention
the rest of the framework follows. A truthy non-boolean is not trusted either:
a predicate that answers with a status string would otherwise grant on `"no"`.

Because the predicate receives the raw `Request`, it composes with whatever the
application already has: a session role, a signed cookie, an IP allow-list, an
upstream header. It can be async.

```ts
import dashboardPlugin from '@bakery-framework/plugin-dashboard'

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

Three session routes are the whole `/api/_dashboard` surface. The console
reads no table data of its own.

The two write routes that used to complete this table — `POST
/api/_dashboard/query` and `POST /api/_dashboard/execute-action` — are not
gated, they are **absent**. No environment variable brings them back. The
console's only mutating endpoints are the two session ones.

`/api/_dashboard/schema` and `/api/_dashboard/table-data` are gone as well.
They outlived the editor as read-only routes with no caller, and `table-data`
was the worse of the two: it passed `JSON.parse(filters)` straight to the ORM's
`getData` with no validation, and an operator the ORM does not recognise is
*dropped* rather than refused — a dropped filter **widens** the result set.
[The explorer](db-explorer.md) validates the vocabulary before the query
builder sees it; this endpoint never learned to.

**An unmatched `/api/_dashboard/*` path answers 404.** It used to answer 204:
the dispatcher returns `null` for a key no route matched, a handler returning
`null` means "not mine", and core turns that into No Content — so a script
still posting to a retired endpoint was told success and changed nothing. The
404 is scoped to `/api/` deliberately, because `null` is exactly how
`/_dashboard/style.css` falls through to the route mount below.

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
`/api/_dashboard` and the segments below it, plus exactly `/_dashboard` and
`/_dashboard/dashboard.js`, and nothing else. A handler at priority 120 that
claimed `/_dashboard/*` would intercept every asset before the mount was ever
consulted. The `/api/` half is matched as a namespace *root* rather than a
string prefix for a second reason: a bare `startsWith` also claims — and then
404s — an application route named `/api/_dashboard-export`.

## The Database entry

What that entry is depends on whether anything serves `/_db`
([`shell.tsx`](../../packages/plugins/dashboard/src/shell.tsx)):

- **With an explorer mounted**, it is an `<a href="/_db">` rather than a tab
  button, and the signpost panel is not rendered at all. A tab whose whole
  content is "go there" is a click of ceremony in front of going there.
- **With nothing at `/_db`**, it stays a tab, and the panel explains where the
  editor went and how to get it back. An entry that silently navigated to a 404
  would be worse than either shape.

The console asks that question **behaviourally** — it walks the fetch registry
for a handler that claims `/_db` *and declines a path nobody serves* — rather
than importing the explorer, so an application serving its own explorer at
`/_db` gets the link too. The second half of the test is load-bearing:
`StaticHandler` sits at priority 0 with a `canHandle` that returns `true`
unconditionally, so "does some handler claim `/_db`" is always yes. Only a
handler that claims a *namespace* declines the control path.

Either way it fetches nothing and ships no client module.

The tab used to be a grid editor over `execute-action` and a raw SQL prompt
over `query`, both behind `DASHBOARD_ALLOW_WRITES=1`. The whole arrangement is
retired in favour of
[`@bakery-framework/plugin-db-explorer`](db-explorer.md), which reaches the
same data through an access level tied to the caller rather than a flag tied
to the process, and which does not accept raw SQL at all.

Register the explorer alongside the console if you want the link to lead
anywhere:

```ts
import { defineConfig } from '@bakery-framework/core'
import dbExplorerPlugin from '@bakery-framework/plugin-db-explorer'
import dashboardPlugin from '@bakery-framework/plugin-dashboard'

export default defineConfig({
  root: 'src',
  plugins: [dashboardPlugin(), dbExplorerPlugin()],
})
```

What this removes is worth stating plainly, because the old text made a
security promise on the flag's behalf: an operator who set
`DASHBOARD_ALLOW_WRITES=1` had a browser tab that could `DROP TABLE`, and one
who left it unset was relying on a statement classifier to tell reads from
writes. Neither situation exists now. Setting the variable does nothing — if
it is still in a deployment environment, delete it; a variable that reads as a
control still in force is worse than no variable at all.

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

- Install the dashboard **without** `@bakery-framework/plugin-analytics` and those calls
  404 silently. The panel stays empty; nothing reports why.
- Install it **with** analytics but set no analytics credential and those
  calls are refused — the analytics endpoints are closed until
  `analyticsPlugin({ credential })` arms them. See
  [Analytics → Authorization](analytics.md#authorization).

The Sessions and Logs panels are unaffected — they use `/api/_dashboard/*`,
which is gated by the `authorize` predicate and works. The Database entry
fetches nothing at all, in either of its shapes.

## Production checklist

- Pass `enabled: false`, or an `authorize` predicate you can defend. There is
  no third option that leaves the console reachable safely.
- Remember that the console runs at the same origin as the application, so an
  XSS anywhere in that origin inherits whatever the predicate grants.
- If you register the explorer for the Database link, give it its own access
  configuration — the console's `authorize` does not carry over. See
  [Database Explorer](db-explorer.md).
