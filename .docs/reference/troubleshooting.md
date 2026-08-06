# Troubleshooting & FAQ

## Startup Errors

### `Config init failed: Cannot find module 'server.config.ts'`

Bakery expects `server.config.ts` to be located in the project root (the directory where you run `bun run dev`).
- Ensure the file exists.
- Ensure it exports a default config using `defineConfig`.

### `Address already in use` or `EADDRINUSE`

The port Bakery is trying to bind to is currently occupied by another process.
- By default, Bakery uses port 3000.
- Find the process using the port: `lsof -i :3000`
- Or override the port via the `.env` file: `PORT=3001`

### `Database Error: UNIQUE constraint failed`

This happens when a schema migration attempts to add a `unique()` index to a column that already contains duplicate data.
- Fix the existing data in the database manually.
- Or drop the index from `schema.ts`, clean the data, and re-add the index.

---

## Development Issues

### Changes to my API files don't reload the browser

Changes to backend files (`api/*`, `.server/*`, `schema.ts`) trigger a **server restart**, not a browser reload. This is intentional.
- The server restarts almost instantly (exit code 42).
- The browser must be refreshed manually to see the output of the new API endpoint.
- Only frontend files (`.html`, `.css`, `.ts` outside of backend paths) trigger the live reload WebSocket.

### My CSS changes are forcing a full page reload

CSS hot-swapping relies on finding the `<link rel="stylesheet">` tag with an `href` that matches the changed file path.
- Ensure your HTML uses standard `<link>` tags for CSS.
- Ensure the `href` path exactly matches the URL path of the file.

### "TSConfig paths synced" keeps logging but the file isn't updating

Bakery only writes to `tsconfig.app.json` if the computed paths differ from the file's current contents. If the file is malformed JSON (e.g., contains comments), Bakery may fail to parse it properly.
- `tsconfig.app.json` must be strict JSON (no trailing commas, no `//` comments).
- Delete `tsconfig.app.json` and let Bakery recreate it.

### The logger terminal doesn't open when I press 'd'

The 'd' shortcut attempts to spawn a detached terminal using common Linux/macOS terminal emulators (`x-terminal-emulator`, `kitty`, `alacritty`, `xterm`, etc.).
- If you are on Windows, the spawned terminal is not supported. You can manually run: `bun run .server/client/log.ts` in a separate command prompt.
- Ensure you have one of the supported terminal emulators in your PATH.

---

## Routing & Requests

### My TSX file is returning 404

1. Ensure the file extension is exactly `.tsx` (not `.ts` or `.jsx`).
2. Ensure the file has a `default` export.
3. Check the startup log to see if the route was registered: `routes  TSX  /my-path → my-file.tsx`

### Request bodies are undefined in API routes

Bakery automatically parses JSON and URL-encoded bodies. If `req.body` is undefined, check:
1. Did you send the correct `Content-Type: application/json` header?
2. Did you use a method that supports bodies (POST, PUT, PATCH)? GET requests do not have bodies; use query parameters instead (`?key=value`).

### I'm getting a 413 Payload Too Large error

The incoming request body exceeded the `maxBodySize` limit.
- Increase the limit in `server.config.ts`: `maxBodySize: 50 * 1024 * 1024` (50MB).

### Why do some files return 403 Forbidden?

Bakery has a strict blocklist for sensitive files. It will refuse to serve:
- `.env`, `*.db`, `*.sql`
- `package.json`, `bun.lock`
- The entire `.server/` directory
See [Security Hardening](../deployment/security.md) for the full list.

---

## Database

### How do I reset the database?

Delete the `.server/database/server.db` file. The next time the server starts, it will create a fresh database and apply the schema from `schema.ts`.

### My column rename created a new column instead of renaming

SQLite (unlike Postgres/MySQL) does not natively support `ALTER TABLE RENAME COLUMN` in older versions, though newer versions (3.35+) do. Regardless, Bakery handles renames safely via the `old()` helper.
- Did you use `old('old_name', value('...'))`?
- If you just change the key in `schema.ts`, Bakery sees it as dropping the old column and adding a new one.

---

## FAQ

### Does Bakery support React or Vue?

Bakery does not use client-side frameworks for its `.tsx` rendering. It compiles TSX to static HTML strings on the server.

You *can* write frontend code in React/Vue and serve it as static files from the `root` directory, but Bakery does not provide built-in SSR hydration for them.

### Can I deploy this to Vercel or AWS Lambda?

No. Bakery is designed as a long-running stateful server process (with WebSockets and an embedded SQLite database). It is best deployed to a VPS (DigitalOcean, Hetzner), Render, Railway, or Fly.io via Docker.

### Why not just use Express/Hono?

You can! But Bakery provides a batteries-included experience specifically tailored for Bun, combining file-based routing, TSX SSR, live reload, sessions, and a type-safe ORM into a single cohesive system without wiring together dozens of npm packages.

---

*[← CLI Reference](./cli.md)*

*[← Back to README](../../README.md)*
