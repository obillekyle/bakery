# WebSockets

Bakery provides first-class WebSocket support through a class-based `WebSocketHandler` API. WebSocket connections are upgraded transparently and routed to the appropriate handler based on the request path.

---

## Overview

WebSocket handling in Bakery is split into two layers:

1. **`WebSocketHandler` classes** — For structured WebSocket endpoints with their own path, data types, and lifecycle methods. Recommended for most use cases.
2. **`websocket` config option** — For a single, application-level fallback WebSocket handler when you don't need path-based routing.

---

## Creating a WebSocket Handler

Extend `WebSocketHandler` from `@server/handlers`:

```typescript
// .server/handlers/routes/my-ws.ts
import { WebSocketHandler } from '../core/$websocket'

export class ChatHandler extends WebSocketHandler {
  // Which WebSocket upgrade requests this handler accepts
  static canHandle(path: string, req: Request): boolean {
    return path === '/ws/chat'
  }

  // Called when a client connects
  static open(ws: ServerWebSocket<{ userId: string }>, data: { userId: string }) {
    console.log(`User connected: ${data.userId}`)
    ws.subscribe('chat')  // subscribe to a pub/sub topic
  }

  // Called when a message is received
  static message(
    ws: ServerWebSocket<{ userId: string }>,
    message: string | Buffer,
    data: { userId: string },
  ) {
    const text = typeof message === 'string' ? message : message.toString()
    ws.publish('chat', JSON.stringify({ from: data.userId, text }))
  }

  // Called when a client disconnects
  static close(
    ws: ServerWebSocket<{ userId: string }>,
    code: number,
    reason: string,
    data: { userId: string },
  ) {
    console.log(`User disconnected: ${data.userId}, code: ${code}`)
  }

  // Called when the send buffer is drained (backpressure cleared)
  static drain(ws: ServerWebSocket<{ userId: string }>, data: { userId: string }) {
    // Optionally resume sending
  }
}
```

---

## Registering a WebSocket Handler

WebSocket handlers are registered via `Bakery.handlers.websocket.set()`. The best place to do this is in a plugin's `setup` or `onStart` hook, or in your `server.config.ts` `onStart`:

```typescript
// In server.config.ts
import Bakery from '@server/core/bakery'
import { ChatHandler } from './.server/handlers/routes/my-ws'

export default defineConfig({
  onStart() {
    Bakery.handlers.websocket.set(ChatHandler)
  },
})
```

Or in a plugin:

```typescript
const wsPlugin = definePlugin({
  name: 'websocket-plugin',
  setup(config) {
    Bakery.handlers.websocket.set(ChatHandler)
  },
})
```

---

## WebSocket Data (Upgrade Payload)

You can attach typed data to the WebSocket connection during the upgrade via the `upgrade` static method. This data is available in all lifecycle methods as the `data` parameter:

```typescript
export class AuthenticatedWSHandler extends WebSocketHandler {
  static canHandle(path: string, req: Request) {
    return path === '/ws/secure'
  }

  static async upgrade(req: Request): Promise<UpgradeData> {
    const session = Session.from(req)
    const userId = session.get('userId')

    if (!userId) return // returning undefined prevents upgrade (connection refused)

    return { userId, role: session.get('role') }
  }

  static open(ws: ServerWebSocket<{ userId: string; role: string }>, data) {
    console.log(`Authenticated user ${data.userId} (${data.role}) connected`)
  }

  static message(ws, message, data) {
    if (data.role !== 'admin') {
      ws.send(JSON.stringify({ error: 'Forbidden' }))
      ws.close()
      return
    }
    // handle admin message
  }
}
```

---

## Pub/Sub Messaging

Bakery's WebSocket system is backed by Bun's built-in pub/sub system. You can:

```typescript
// Subscribe a socket to a topic
ws.subscribe('room:42')

// Unsubscribe
ws.unsubscribe('room:42')

// Broadcast to all subscribers of a topic (from any handler)
Bakery.server?.publish('room:42', 'Hello everyone!')

// Send to a specific socket
ws.send('Hello, you specifically')

// Check if subscribed
ws.isSubscribed('room:42')
```

---

## Config-Level WebSocket Fallback

For simple use cases without path-based routing, configure WebSocket handlers directly in `server.config.ts`:

```typescript
export default defineConfig({
  websocket: {
    message(ws, message) {
      ws.send(`Echo: ${message}`)
    },
    open(ws) {
      console.log('Connected:', ws.remoteAddress)
    },
    close(ws, code, reason) {
      console.log('Disconnected:', code)
    },
    drain(ws) {},
  },
})
```

This fallback is only invoked for WebSocket connections that are **not** handled by a registered `WebSocketHandler` class.

---

## Live Reload WebSocket

Bakery's internal `LiveReloadHandler` uses a WebSocket at `/_livereload` to push file change notifications to the browser. This handler is automatically registered in development mode. It also enables:

- **Force reload from browser**: The client can send `{ type: 'force_reload' }` to trigger a server-side reload broadcast.
- **Logger subscription**: Connected devtools (via the `d` key shortcut) subscribe to `{ type: 'subscribe_logger' }` and receive all server-side log events in real time.
- **Client log forwarding**: `console.log`, `console.warn`, and `console.error` from the browser are forwarded to the server terminal.

---

## TypeScript Types

```typescript
// ServerWebSocket with typed data
type ServerWebSocket<T = Record<string, any>> = Bun.ServerWebSocket & {
  data: WebSocketData<T>
}

type WebSocketData<T> = {
  this: typeof WebSocketHandler
  type: 'websocket'
  orig: string   // the handler class name
  path: string   // the request path
  data: T        // your custom upgrade data
}
```

Declare your application's WebSocket payloads globally for editor autocompletion:

```typescript
// In global.d.ts or a .d.ts file
declare global {
  interface WebSocketPayloads {
    chat: { userId: string; username: string }
    notifications: { userId: string }
  }
}
```

---

*[← Reverse Proxy](./proxy.md) · [Live Reload & Hot Module Sync →](../development/live-reload.md)*

*[← Back to README](../../README.md)*
