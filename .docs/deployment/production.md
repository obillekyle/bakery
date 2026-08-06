# Building for Production

Bakery is designed to minimize the gap between development and production. The same routing logic, TSX transpilation, and database queries run in both environments. The primary differences in production are:

1. **No file watcher:** The server does not restart on file changes.
2. **No live reload:** The `/_livereload` WebSocket endpoint is inactive, and the client script is not injected.
3. **Asset minification:** Compiled browser assets (TS, CSS, virtual imports) are minified by Bun's transpiler.
4. **Environment flags:** `import.meta.env.DEV` is `false`, and `import.meta.env.PROD` is `true`.

---

## Starting the Production Server

To start Bakery in production mode:

```bash
bun run serve
```

This starts the server directly without the dev master supervisor process.

### Environment Setup

Ensure you have a `.env` file or environment variables set for your production environment:

```ini
# .env
DB_URL=postgres://user:password@db.internal:5432/bakery_prod
DASHPASS=a_strong_password_here
PORT=80
```

---

## Running Behind a Reverse Proxy

While Bakery can serve directly to the web (e.g., binding to port 80/443), it is often run behind a dedicated reverse proxy or load balancer like Nginx, Caddy, or Cloudflare Tunnels.

### Nginx Example

```nginx
server {
    listen 80;
    server_name myapp.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_addrs;
    }
}
```

### Trusting X-Forwarded-For

When behind a reverse proxy, the client IP seen by Bakery will be the proxy's internal IP. If you need the real client IP (e.g., for analytics or rate limiting), read the `X-Forwarded-For` header:

```typescript
const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip')
```

---

## Docker Deployment

Bakery runs perfectly in a Docker container. Here is an optimized `Dockerfile`:

```dockerfile
# Use the official Bun image
FROM oven/bun:1 as base
WORKDIR /app

# Install dependencies (only types needed, but good for reproducibility)
FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Final image
FROM base AS release
COPY --from=install /app/node_modules node_modules
COPY . .

# Environment variables
ENV PORT=3000
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Run schema sync and start server
CMD ["sh", "-c", "bun run db:sync && bun run serve"]
```

Build and run:

```bash
docker build -t bakery-app .
docker run -p 3000:3000 -v bakery_data:/app/.server/database bakery-app
```

> **Important:** If using the default SQLite database, ensure the `.server/database` directory is mounted as a persistent volume.

---

## Scaling

### Vertical Scaling

Bun is single-threaded, but its asynchronous I/O and HTTP implementation are extremely fast. A single Bakery process can handle thousands of concurrent requests.

### Horizontal Scaling

If you need to scale across multiple instances:

1. **Database:** You cannot use SQLite. Set `DB_URL` to a shared PostgreSQL or MySQL instance.
2. **Sessions:** Because sessions use a tiered memory/SQLite cache, horizontal scaling requires either sticky sessions (so a user always hits the same instance) or a shared session store (currently not built-in; you would need a custom session backend, e.g., Redis).
3. **Cache:** The LRU cache is per-instance. Instances will cache assets independently.

---

## Zero Downtime Reloads

Because Bun starts quickly, a simple restart (`pm2 restart bakery` or a rolling Docker deploy) is often sufficient. Bakery does not currently support graceful hot-swapping of the listening socket between processes natively, though this can be achieved externally via load balancer draining.

The `onShutdown` lifecycle hook is called on `SIGTERM`. Use it to close external connections or flush metrics before exit.

---

*[← Dashboard Plugin](../plugins/dashboard.md) · [Security Hardening →](./security.md)*

*[← Back to README](../../README.md)*
