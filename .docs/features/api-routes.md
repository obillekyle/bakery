# API Routes

Bakery provides a convention-based API routing system. Any TypeScript or JavaScript file placed in the `api/` directory at your project root becomes an HTTP endpoint accessible at the `/api/` URL prefix.

---

## Creating an API Route

Create a file in the `api/` directory and export a default function:

```typescript
// api/hello.ts
export default function(req: Request, body: Record<string, any>) {
  return { message: 'Hello, world!', method: req.method }
}
```

This endpoint is now available at:
- `GET /api/hello`
- `POST /api/hello`
- `PUT /api/hello` — any HTTP method

---

## Handler Signature

The default export of an API file can be either a **function** or a **static value**:

```typescript
type ApiCallback<T = any> = (
  req: Request,
  body: Record<string, any>,
  server: Bun.Server
) => MixedPromise<T>
```

| Export Type | Behavior |
|-------------|----------|
| `async function` | Called per request; return value is serialized |
| `function` | Same as async |
| `object` | Returned as-is on every request (static response) |
| `string` | Returned as plain text |

---

## The `body` Parameter

The `body` argument merges:

1. **Request body** — parsed from JSON, form-data, or URL-encoded body
2. **URL query string** — parsed from `?key=value`
3. **Route parameters** — from dynamic `[param]` segments

All three sources are merged shallowly, with route parameters taking highest precedence.

```typescript
// api/users/[id].ts
export default function(req: Request, body: { id: string; name?: string }) {
  // GET /api/users/42?name=Alice
  // body.id = "42", body.name = "Alice"
  return { userId: body.id, name: body.name }
}
```

---

## Response Formats

The API handler automatically serializes return values:

| Return Type | HTTP Response |
|-------------|--------------|
| `Response` | Passed through as-is |
| `object` | `200 OK` with `Content-Type: application/json` |
| `string` | `200 OK` with `Content-Type: text/plain` |
| `undefined` | `204 No Content` |

### JSON Response Envelope

When returning an object, Bakery wraps it in a standardized envelope:

```json
{
  "time": 12.34,
  "status": 200,
  "message": "Success",
  "data": { /* your object */ }
}
```

The `time` field is the request duration in milliseconds (measured from request receipt to response).

### Manual Response Control

For full control, return a `Response` object:

```typescript
export default function(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

### Using the `response` Helper

Bakery exposes a `response` utility with convenience methods:

```typescript
import { response } from '@server/utils/http'

export default function(req: Request, body: any) {
  if (!body.name) {
    return response.json.error(400, 'Missing required field: name')
  }

  return response.json.success('User created', { id: 1, name: body.name }, 201)
}
```

`response` API:

```typescript
response(body?, init?)                               // raw Response
response.json(status, message, data?)                // JSON envelope
response.json.success(message, data?, status?)       // 200 success envelope
response.json.error(status?, message?, data?)        // error envelope
response.html(html, status?, init?)                  // text/html response
response.text(text, status?, init?)                  // text/plain response
response.href(url, status?)                          // redirect (301/302/307/308)
response.type(body, contentType, init?)              // custom content-type
response.error(error, code?, init?)                  // generic error
```

---

## Method-Specific Routing

Bakery's API handler does not route by HTTP method by default. Implement method switching inside your handler:

```typescript
// api/posts.ts
export default async function(req: Request, body: { title?: string }) {
  switch (req.method) {
    case 'GET':
      const posts = await DB.table('posts').selectAll('posts').array()
      return response.json.success('Posts fetched', posts)

    case 'POST':
      if (!body.title) return response.json.error(400, 'Title is required')
      // create post...
      return response.json.success('Post created', { title: body.title }, 201)

    default:
      return new Response('Method Not Allowed', { status: 405 })
  }
}
```

---

## Accessing the Session

```typescript
// api/auth.ts
import { Session } from '@server/core/session'

export default function(req: Request, body: { username?: string }) {
  const session = Session.from(req)

  if (req.method === 'POST' && body.username) {
    session.set('user', body.username, true) // persist = true
    return response.json.success('Logged in')
  }

  const user = session.get('user')
  return { user: user ?? null }
}
```

---

## Error Handling in API Routes

If an API handler throws an unhandled exception, the `ApiErrorHandler` (priority `30` in the error pipeline) catches it and returns:

```json
{
  "status": 500,
  "message": "Internal Server Error"
}
```

For structured errors, throw with a status code or use `response.json.error`:

```typescript
export default async function(req: Request, body: { id?: number }) {
  if (!body.id) {
    return response.json.error(400, 'id is required')
  }

  const user = await DB.table('users')
    .where({ users: 'id' }, '=', body.id)
    .selectAll('users')
    .fetch()

  if (!user) {
    return response.json.error(404, 'User not found')
  }

  return response.json.success('User found', user)
}
```

---

## Dynamic API Routes

```
api/
├── hello.ts             → /api/hello
├── users/
│   ├── index.ts         → /api/users
│   └── [id].ts          → /api/users/:id
└── posts/
    ├── index.ts         → /api/posts
    └── [postId]/
        └── comments.ts  → /api/posts/:postId/comments
```

---

## Request Context

Inside an API handler, you can access the current request via `Bakery.getRequest()` from anywhere in the call stack (not just the handler function itself). This uses Node.js `AsyncLocalStorage` under the hood:

```typescript
// lib/auth.ts
import Bakery from '@server/core/bakery'

export function getCurrentUser() {
  const req = Bakery.getRequest()
  return Session.from(req).get('user')
}
```

```typescript
// api/profile.ts
import { getCurrentUser } from '../lib/auth'

export default function() {
  const user = getCurrentUser() // no need to pass req
  return { user }
}
```

---

*[← Static Assets](./static-assets.md) · [TSX Server-Side Rendering →](./tsx-rendering.md)*

*[← Back to README](../../README.md)*
