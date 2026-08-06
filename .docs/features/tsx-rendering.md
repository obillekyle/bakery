# TSX Server-Side Rendering

Bakery supports server-side rendering via `.tsx` files placed in your `root` directory. Unlike React or Vue, there is no virtual DOM, no hydration, and no client-side framework. TSX files are executed on the server and their output is streamed as HTML strings.

---

## How It Works

When a request matches a `.tsx` file, the `TSXHandler`:

1. Resolves the file from the route system (static or dynamic).
2. Dynamically imports the file using Bun's native ESM loader.
3. Calls the `default` export function with `(req, body)`.
4. If the return value is a string, attempts HTML injection (head, body, livereload client).
5. Returns the final HTML response.

---

## Creating a TSX Page

```tsx
// src/blog/index.tsx

export default function(req: Request, body: Record<string, any>) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>My Blog</title>
      </head>
      <body>
        <h1>Welcome to My Blog</h1>
        <p>Request path: {new URL(req.url).pathname}</p>
      </body>
    </html>
  )
}
```

The TSX is compiled by the server — **no client-side JavaScript is involved** in rendering this page. The browser receives a complete HTML string.

---

## JSX Transform

Bakery uses a **string-based JSX transform** — not React. JSX expressions are compiled directly to concatenated HTML strings. This means:

- No `React.createElement` or virtual DOM overhead.
- No `key` prop requirement.
- No hooks, state, or lifecycle methods.
- HTML is produced synchronously as a string.

The JSX namespace is declared globally in `.server/global.d.ts`. The `JSX.Element` type is `string`.

### Supported JSX Attributes

All standard HTML attributes are supported. Boolean attributes work naturally:

```tsx
// These are equivalent:
<input disabled={true} />
<input disabled />

// Boolean false omits the attribute:
<input disabled={false} />  →  <input />

// Style objects are converted to inline CSS strings:
<div style={{ color: 'red', fontSize: '16px' }} />
→ <div style="color: red; font-size: 16px;" />
```

### Data and ARIA Attributes

```tsx
<div data-id="123" aria-label="Close button" />
```

---

## Async TSX

The default export can be `async`:

```tsx
// src/blog/[slug].tsx
import { DB } from '@database'

export default async function(req: Request, body: { slug: string }) {
  const post = await DB.table('blogs')
    .where({ blogs: 'title' }, 'LIKE', `%${body.slug}%`)
    .selectAll('blogs')
    .fetch()

  if (!post) {
    return new Response('Not Found', { status: 404 })
  }

  return (
    <article>
      <h1>{post.title}</h1>
      <div>{post.content}</div>
    </article>
  )
}
```

---

## Returning Different Response Types

| Return Value | Behavior |
|-------------|----------|
| `string` | Served as `text/html`, with script/style injection applied |
| `JSX.Element` (string) | Same as string |
| `Response` | Passed through as-is |
| `object` | Serialized as JSON with `200 OK` |
| `undefined` / `null` | `404 Not Found` |

---

## HTML Injection

Bakery automatically injects the following into any HTML string that contains a closing `</head>` or `</body>` tag:

- Your configured `head` HTML string (into `<head>`)
- Your configured `body` HTML string (into `<body>`)
- `/_client/livereload.js` script (in development only)
- The generated `<script type="importmap">` (if `importMap` is configured)

This injection is applied to all HTML responses: `.html` files, TSX string returns, and API handlers returning HTML strings.

---

## Shared Layout Pattern

Since JSX is just a function returning a string, you can create shared layout components:

```tsx
// src/Layout.tsx
type Props = {
  title: string
  children: string
}

export default function Layout({ title, children }: Props) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} — My Site</title>
      </head>
      <body>
        <nav>
          <a href="/">Home</a>
          <a href="/blog">Blog</a>
        </nav>
        <main>{children}</main>
        <footer>© 2026 My Site</footer>
      </body>
    </html>
  )
}
```

```tsx
// src/blog/index.tsx
import Layout from '../Layout'

export default async function() {
  const posts = await DB.table('blogs').selectAll('blogs').array()

  return (
    <Layout title="Blog">
      <h1>All Posts</h1>
      <ul>
        {posts.map(post => (
          <li>
            <a href={`/blog/${post.id}`}>{post.title}</a>
          </li>
        ))}
      </ul>
    </Layout>
  )
}
```

---

## TSX Error Pages

Custom error pages can be built as TSX files. Bakery's `TSXErrorHandler` scans for files matching `error.tsx` and `error-*.tsx` in your serve root:

```tsx
// src/error.tsx
export default function(req: Request, body: {
  errorCode: number
  errorText: string
  errorBody: string
}) {
  return (
    <html lang="en">
      <head>
        <title>Error {body.errorCode}</title>
      </head>
      <body>
        <h1>{body.errorCode} — {body.errorText}</h1>
        <p>{body.errorBody}</p>
        <a href="/">Return Home</a>
      </body>
    </html>
  )
}
```

The error body data is merged into the `body` parameter alongside any route params.

---

## TypeScript in TSX

Because Bakery executes TSX files server-side using Bun, you have full access to all server-side APIs: database, sessions, the file system, and anything Bun exposes. There is no `window`, `document`, or browser API available at render time.

```tsx
// src/dashboard.tsx — server-side only
import { DB } from '@database'
import { Session } from '@server/core/session'

export default async function(req: Request) {
  const session = Session.from(req)
  const username = session.get('username')

  if (!username) {
    return response.href('/login', 302)
  }

  const stats = await DB.table('users')
    .selectAll('users')
    .selectMath({ count: { COUNT: '*' } })
    .fetch()

  return (
    <main>
      <p>Welcome, {username}</p>
      <p>Total users: {stats?.count}</p>
    </main>
  )
}
```

---

*[← API Routes](./api-routes.md) · [Middleware →](./middleware.md)*

*[← Back to README](../../README.md)*
