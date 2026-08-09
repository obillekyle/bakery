# WebSockets

WebSockets have their own registry — `Bakery.handlers.websocket` — with its own
handler base class and its own dispatch path. Nothing about the `fetch` registry
applies here.

## The upgrade is dispatched first

`handleRequest` checks for the upgrade header before it does anything else with
the request (`packages/core/src/router.ts`):

```ts no-check — an excerpt of framework internals, quoted for reference
if (req.headers.get('Upgrade') === 'websocket') {
  const wsHandled = await upgradeWebsocket(req, path)
  return wsHandled
    ? WebSocketHandler.WS_UPGRADE
    : response.error('WebSocket Upgrade Failed', 400)
}
```

Two consequences worth internalising:

- **Middleware does not run for WebSocket upgrades.** `config.middleware` lives
  in the `fetch` registry, which is never reached. Neither are the plugin
  `onRoute` / `onRequest` hooks, which sit two lines further down.
- **Authorisation has to live in the handler's `canHandle`.** The analytics
  plugin says so in a comment, having learned it the hard way: without a check
  there, its socket served the same payload its guarded HTTP endpoint refused —
  and pushed it live every second
  (`packages/plugins/analytics/src/endpoints/websocket.ts`).

Rate limiting *does* apply, because it runs in `Bun.serve`'s fetch callback above
the router (`packages/cli/src/worker.ts`).

The header comparison is against the exact lowercase string `websocket`. Browsers
send that; a hand-rolled client sending `Upgrade: WebSocket` will not match and
will fall through to normal routing.

If no registered handler claims the path, the client gets `400 WebSocket Upgrade
Failed`.

## Cross-origin handshakes are refused before dispatch

WebSockets are exempt from the same-origin policy: without a check, any page a
user has open can connect to any socket your server exposes, with their cookies
attached. `upgradeWebsocket` therefore compares the handshake's `Origin` against
the request's own hostname *before* it consults the registry, so every socket
inherits the check instead of every author having to remember it
([`utils/http/csrf.ts`](../../packages/core/src/utils/http/csrf.ts)). A mismatch
is refused with the same `400 WebSocket Upgrade Failed`; the reason goes to the
log.

Three details worth knowing:

- **Hostnames are compared, not full origins.** A TLS-terminating proxy leaves
  the request looking like `http://app.example:3000` while the browser reports
  `https://app.example`, and comparing origins would refuse every socket in that
  deployment.
- **`Origin: null` is refused.** That is what a sandboxed iframe and a `file://`
  page send. The HTTP CSRF guard tolerates it; this one does not.
- **A request with no `Origin` at all is allowed.** A browser never omits it on
  a handshake, so its absence means a non-browser client — which could equally
  have forged the header, so refusing it would break curl and tests while buying
  nothing.

This is not authentication. It stops another *site* driving the socket; it does
nothing about a client that is not a browser. Sockets carrying anything
sensitive still authorise in `canHandle`, which is what the analytics plugin
does.

## Writing a handler

Subclass `WebSocketHandler` and register it. Everything is static, like every
other handler.

```ts
import { Bakery } from '@bakery-framework/core'
import { WebSocketHandler } from '@bakery-framework/core/handlers'

type ChatData = { room: string }

export class ChatHandler extends WebSocketHandler {
  static override canHandle(path: string, req: Request) {
    if (path !== '/ws/chat') return false
    return Boolean(req.headers.get('cookie'))
  }

  static override upgrade(req: Request): ChatData {
    const room = new URL(req.url).searchParams.get('room') || 'lobby'
    return { room }
  }

  static override open(ws: ServerWebSocket<ChatData>, data: ChatData) {
    ws.subscribe(data.room)
    ws.send(JSON.stringify({ type: 'joined', room: data.room }))
  }

  static override message(
    ws: ServerWebSocket<ChatData>,
    msg: string | Buffer,
    data: ChatData,
  ) {
    ws.publish(data.room, String(msg))
  }

  static override close(
    ws: ServerWebSocket<ChatData>,
    code: number,
    reason: string,
    data: ChatData,
  ) {
    ws.unsubscribe(data.room)
  }
}

Bakery.handlers.websocket.set(ChatHandler)
```

### `canHandle(path, req)`

Decides whether this handler owns the socket. **The base implementation returns
`true`** (`packages/core/src/handlers/core/$websocket.ts`), so a subclass
that forgets to override it claims every upgrade on the server. Always override
it, and do the authorisation there — `req` is the full upgrade request, headers
and cookies included.

### `upgrade(req, path)`

Returns the per-connection state. Whatever you return is stashed and handed back
as the last argument to `open`, `message`, `close` and `drain`
(`$websocket.ts`). Return nothing and the handlers receive `{}`.

This is the only place you see the `Request`. Extract everything you need from it
here — the query string, the session id, the resolved user — because the socket
callbacks never get another look at it.

### `open` / `message` / `close` / `drain`

Standard Bun WebSocket callbacks, plus the `data` argument. `ws` is Bun's
`ServerWebSocket`, so `ws.send`, `ws.subscribe`, `ws.publish`, `ws.unsubscribe`
and `ws.remoteAddress` all work as documented by Bun.

A throw inside any of them is caught, logged as `UNHANDLED_ERR`, and swallowed
(`packages/core/src/router.ts`). The connection stays open. That is
usually what you want for frames arriving from a client, but it does mean a
broken handler fails quietly — check the log.

### Registration

```ts no-check — fragment; `MyHandler` is defined by the surrounding module
Bakery.handlers.websocket.set(MyHandler)
```

The websocket registry sorts by priority like the others, but nothing in the
framework passes one — the default is 10 (`$registry.ts`), and handlers are
distinguished by their `canHandle` paths rather than by ordering. Register from a
plugin's `setup()` or during app startup.

## Per-connection host context

The resolved per-host config is captured at upgrade time and re-established
around every socket callback via `hostStore.run`
(`router.ts`, `$websocket.ts`). So `Bakery.config` inside a socket
handler is the config for the host that opened the connection, not the process
default — even though the request that established it is long gone.

## What `ws.data` looks like

The framework wraps your state rather than replacing it (`$websocket.ts`):

```ts no-check — the runtime shape of ws.data, for debugging
{
  this: ChatHandler,          // the class, used to route callbacks
  type: 'websocket',
  orig: 'ChatHandler',
  path: '/ws/chat',
  hostname: 'example.com',
  config: { /* the resolved per-host config */ },
  data: { room: 'lobby' },    // what your upgrade() returned
}
```

Your callbacks receive `ws.data.data` as their `data` argument. Reach into
`ws.data` directly only when debugging.

## The config-level fallback

`config.websocket` is a plain `Bun.WebSocketHandler`. It handles sockets whose
`ws.data.this` is not a registered `WebSocketHandler` — that is, sockets upgraded
by calling `Bakery.server.upgrade()` yourself
(`router.ts`, `router.ts`).

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  websocket: {
    message(ws, message) {
      ws.send(message)
    },
  },
})
```

Sockets that a registered handler claimed never reach it. Prefer a
`WebSocketHandler` subclass: it gets the path routing, the auth seam and the host
context for free.

## Reserved socket paths

| Path | Owner | Notes |
| --- | --- | --- |
| `/_livereload` | `LiveReloadHandler` | dev only; `canHandle` refuses unless `DEV` **and** `DEV_WORKER` |
| `/_analytics_ws` | `AnalyticsWSHandler` | analytics plugin; authorises in `canHandle` |

`LiveReloadHandler` is a compact worked example of the pattern
(`packages/core/src/handlers/routes/livereload.ts`): it subscribes every socket
to a `livereload` topic in `open`, accepts `subscribe_logger`, `force_reload` and
`client_log` messages, and broadcasts with `ws.publish`.

## Client side

Nothing framework-specific — a plain `WebSocket`:

```ts
const ws = new WebSocket(`ws://${location.host}/ws/chat?room=general`)

ws.addEventListener('open', () => ws.send('hello'))
ws.addEventListener('message', event => console.log(event.data))
```

The upgrade request carries the browser's cookies, so a session established over
HTTP is visible to `canHandle`.
