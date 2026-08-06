# Security Hardening

Bakery includes several built-in security mechanisms, but production deployments require careful attention to configuration and environment setup.

---

## 1. Path Blocking

Bakery's `StaticHandler` actively prevents sensitive files from being served to the web.

### Default Blocklist

The following patterns return `403 Forbidden` automatically:

- `**/.server/**` (Internal runtime code)
- `**/server.config.ts`, `**/schema.ts` (Configuration and DB schema)
- `**/*.env`, `**/.env` (Environment variables)
- `**/*.db`, `**/*.sql` (Databases and dumps)
- `**/.git/**`, `**/.vscode/**` (VCS and editor data)
- `**/node_modules/**` (Raw node modules)
- `**/*.json`, `**/*.yaml`, `**/*.yml` (Config files, package.json, lockfiles)
- `**/*.exe` (Binaries)

### Adding Custom Blocks

If your application has other sensitive directories (e.g., `private/`, `uploads/secure/`), add them to the `blocked` array in `server.config.ts`:

```typescript
export default defineConfig({
  blocked: [
    'private/**',
    'uploads/secure/**',
    '**/*.pem',
  ],
})
```

### Path Traversal

Bakery normalizes all request URLs and actively rejects any path containing `..` or null bytes (`\0`) with a `400 Bad Request`.

---

## 2. Dashboard Protection

The built-in Dashboard plugin exposes internal server metrics, database access, and session data. It is a critical security boundary.

**Always set the `DASHPASS` environment variable in production.**

```ini
DASHPASS=strong_random_password
```

If you do not need the dashboard in production, disable it conditionally:

```typescript
// server.config.ts
import dashboardPlugin from '@plugins/dashboard'

export default defineConfig({
  plugins: [
    dashboardPlugin({
      enabled: process.env.NODE_ENV !== 'production',
    }),
  ],
})
```

---

## 3. Rate Limiting

Bakery does not include built-in rate limiting out of the box, as this is often handled better by a reverse proxy (Nginx, Cloudflare).

If you expose Bakery directly, implement rate limiting in the `middleware` array:

```typescript
const requestCounts = new Map<string, number>()
setInterval(() => requestCounts.clear(), 60000)

export default defineConfig({
  middleware: [
    (req) => {
      const ip = req.headers.get('x-forwarded-for') || 'unknown'
      const count = (requestCounts.get(ip) || 0) + 1
      requestCounts.set(ip, count)

      if (count > 100) {
        return new Response('Rate Limit Exceeded', { status: 429 })
      }
    }
  ]
})
```

---

## 4. Secure Cookies

By default, Bakery's session cookie does not set the `Secure` flag (which restricts the cookie to HTTPS only) because development often happens over HTTP `localhost`.

In production, you should set the `Secure` flag if your site uses HTTPS. You can do this by wrapping responses via the `onRequest` hook in a plugin, or rely on a reverse proxy to rewrite the `Set-Cookie` header.

```nginx
# Nginx example: rewrite session cookie to add Secure flag
proxy_cookie_flags sId secure samesite=lax;
```

---

## 5. Body Size Limits

To prevent memory exhaustion attacks from massive uploads, Bakery limits the size of incoming request bodies.

The default limit is **20 MB**. Exceeding this returns a `413 Payload Too Large`.

Configure this in `server.config.ts`:

```typescript
export default defineConfig({
  // Limit to 5 MB
  maxBodySize: 5 * 1024 * 1024,
})
```

---

## 6. Database Injection

The Bakery Query Builder (`DB.QB`) and `Mutation` APIs use parameterized queries (prepared statements) exclusively.

```typescript
// SAFE: values are parameterized
await DB.table('users').where({ users: 'username' }, '=', req.body.user).array()

// SAFE: Mutation values are parameterized
await Mutation.insert('posts', { content: req.body.content })
```

**Warning on `QBRaw`:**

When using `DB.QBRaw`, always pass user input via the binding array, never via string interpolation:

```typescript
// ❌ VULNERABLE TO SQL INJECTION
new DB.QBRaw(`SELECT * FROM users WHERE username = '${req.body.user}'`)

// ✅ SAFE
new DB.QBRaw(`SELECT * FROM users WHERE username = ?`, [req.body.user])
```

---

## 7. XSS Prevention

When writing TSX, all text content and attribute values are automatically HTML-escaped by Bakery's JSX transform:

```tsx
const userInput = '<script>alert(1)</script>'

// Safe: outputs &lt;script&gt;alert(1)&lt;/script&gt;
<div>{userInput}</div>

// Safe: outputs value="&lt;script&gt;alert(1)&lt;/script&gt;"
<input value={userInput} />
```

If you explicitly need to render unescaped raw HTML, use the `raw` helper (use with extreme caution):

```tsx
import { raw } from '@server/utils/html'

// DANGEROUS: renders the script tag exactly as is
<div>{raw(userInput)}</div>
```

---

*[← Building for Production](./production.md) · [Handler Architecture →](../advanced/handler-architecture.md)*

*[← Back to README](../../README.md)*
