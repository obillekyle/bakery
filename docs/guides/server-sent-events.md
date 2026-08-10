# Server-sent events

One-way streaming from server to browser over an ordinary HTTP response: no
upgrade, no subprotocol, and the browser reconnects on its own. It is the
cheaper half of the WebSocket pair and the right shape for progress bars,
notifications, log tailing and live counters — anything where the client only
listens.

```ts
import { defineRoute, sse } from '@bakery-framework/core'

export default defineRoute(req =>
  sse(req, stream => {
    const timer = setInterval(() => stream.send({ at: Date.now() }), 1000)
    return () => clearInterval(timer)
  }),
)
```

Save that as `src/api/ticks.ts` and consume it:

```ts
const events = new EventSource('/api/ticks')
events.onmessage = e => console.log(JSON.parse(e.data))
```

`sse` returns a `Response`, so it is a normal return value from an API route, a
page handler, a middleware, or a plugin endpoint. Nothing needs registering.

## Why this is a helper and not four lines of your own

A route could always return a `Response` wrapping a `ReadableStream` and it
would reach the client intact — `ETag.sendResponse` returns early without an
`ETag`, and the HTML injector ignores anything that is not HTML. What is easy to
get wrong is the framing, and every mistake in it is silent:

- **A newline in your payload truncates the event.** `data: {"a":\n1}` ends the
  data field at the newline and the client sees a cut-off message, not an error.
  Pretty-printed JSON and stack traces both hit this. `encodeSSE` prefixes
  *every* line.
- **A frame without a trailing blank line never arrives.** The client buffers it
  forever, so the symptom is "nothing happens".
- **A write after the client has gone throws**, and it throws inside your timer
  callback, where nothing is catching. `stream.send` after close is a no-op.
- **An idle connection gets cut by proxies at 30–60s**, and the browser
  reconnects silently — so the symptom is duplicated server work, not an error.
  A keep-alive comment every 15s prevents it.
- **nginx buffers proxied responses by default**, holding every event until the
  buffer fills. Works in development, hangs in production. The response carries
  `X-Accel-Buffering: no`.

## The stream handle

The producer receives one object
([packages/core/src/utils/http/sse.ts](../../packages/core/src/utils/http/sse.ts)):

| Member | What it does |
| --- | --- |
| `send(message)` | Send one event. A no-op once closed. |
| `comment(text?)` | Send a `:` comment — invisible to `onmessage`, useful as a heartbeat. |
| `close()` | End the stream. Idempotent. |
| `closed` | `true` once the client has gone or `close()` has run. |

`send` takes either a full `SSEMessage` or a bare value, which is wrapped as its
`data`. These two are the same event:

```ts
import { encodeSSE } from '@bakery-framework/core'

const a = encodeSSE({ data: { hello: 'world' } })
const b = encodeSSE({ data: 'plain text' })
```

A message has four fields, three of them optional:

| Field | Wire | Meaning |
| --- | --- | --- |
| `data` | `data:` | The payload. `JSON.stringify`d unless it is already a string. |
| `event` | `event:` | A named event. The client listens with `addEventListener(name, …)` instead of `onmessage`. |
| `id` | `id:` | Echoed back as the `Last-Event-ID` header when the browser reconnects. |
| `retry` | `retry:` | How long the browser waits before reconnecting, in ms. |

`data: undefined` still emits an empty `data:` line rather than nothing at all —
a frame with no data line is a *comment* to the client, so the event would vanish
instead of arriving empty.

## Cleanup is the part that matters

**Return a cleanup function from the producer.** It runs exactly once, when the
client disconnects or `close()` is called, and it is the only reliable place to
stop a timer or unsubscribe:

```ts
import { defineRoute, sse } from '@bakery-framework/core'

const listeners = new Set<(v: unknown) => void>()

export default defineRoute(req =>
  sse(req, stream => {
    const listener = (value: unknown) => stream.send({ event: 'update', data: value })
    listeners.add(listener)
    return () => listeners.delete(listener)
  }),
)
```

Without it, a closed connection leaves the interval running or the listener
registered for the life of the process, and the leak is invisible — the client is
gone, so nothing complains. A browser tab left open overnight reconnecting every
few minutes turns that into hundreds of dead subscriptions.

Cleanup runs once even if `close()` is called twice, so an unsubscribe cannot
become a double-unsubscribe.

## Options

```ts
import { defineRoute, sse } from '@bakery-framework/core'

export default defineRoute(req =>
  sse(req, stream => stream.send({ data: 'hello' }), {
    keepAlive: 30_000,
    retry: 3000,
  }),
)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `keepAlive` | `15000` | Milliseconds between automatic keep-alive comments. `0` disables them. |
| `retry` | none | An initial `retry:` hint, sent once before any event. |

Lower `keepAlive` if something between you and the client cuts idle connections
faster than 15 seconds. Set it to `0` only for a stream you know is short-lived.

## What happens when things go wrong

- **The request is already aborted.** Nothing the producer writes escapes; the
  response body is empty.
- **The producer throws.** The stream closes rather than hanging. A client left
  on a connection nobody will ever write to again is the worse outcome, since
  the browser will not reconnect from it.
- **The client disconnects mid-stream.** `stream.closed` flips, further `send`
  calls are dropped, and cleanup runs.

## SSE or WebSockets

| | SSE | WebSocket |
| --- | --- | --- |
| Direction | server → client only | both |
| Transport | plain HTTP response | upgrade handshake |
| Reconnect | automatic, with `Last-Event-ID` | yours to write |
| Binary | no | yes |
| Through a dumb proxy | usually, with the buffering opt-out | often blocked |

If the client never needs to send anything, use SSE — the reconnect handling
alone is worth it. See [WebSockets](websockets.md) for the other half.

## Notes

- **The CSRF guard does not apply.** `GET` is a safe method, and `EventSource`
  can only issue `GET`. Cross-origin reads are still governed by
  [CORS](cors.md) — `EventSource` sends no `Origin` header for a same-origin
  request, and a cross-origin one needs `cors` configured.
- **`EventSource` cannot set headers.** No `Authorization`, no custom token.
  Same-origin cookie sessions work, since the browser attaches them; anything
  else has to travel in the URL, which means it lands in access logs. For
  authenticated streams prefer a session cookie.
- **One connection per stream, held open.** Under `--threads N` each connection
  pins one worker for its lifetime. Browsers also cap concurrent connections per
  origin (six on HTTP/1.1), which is a real limit if you open several streams per
  page — HTTP/2 at the proxy removes it.

## Next

- [WebSockets](websockets.md) — the bidirectional half.
- [API routes](api-routes.md) — what else a route can return.
- [CORS](cors.md) — reading a stream from another origin.
</content>
