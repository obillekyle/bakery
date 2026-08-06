# CLI Reference

Bakery is run via `bun run` scripts defined in your `package.json`.

---

## Commands

### `bun run dev`

Starts the Bakery server in development mode.

**Alias for:** `bun run .server --dev`

**Behavior:**
- Spawns the dev master supervisor process.
- Starts the file watcher.
- Enables the live reload WebSocket.
- Disables asset minification.
- Binds to the port specified in `server.config.ts` (default: 3000).

**Keyboard Shortcuts:**
- `s` — Gracefully stop the server.
- `d` — Spawn a detached logger terminal.
- `Ctrl+C` — Kill the process.

---

### `bun run serve`

Starts the Bakery server in production mode.

**Alias for:** `bun run .server`

**Behavior:**
- Runs the HTTP worker directly (no supervisor).
- No file watching or live reload.
- Enables asset minification (TS/CSS).
- Enables aggressive ETag caching.

**Flags:**
- `--port <number>` — Override the port (useful for CI/CD if `PORT` env var isn't preferred).

---

### `bun run db:sync`

Runs the database schema synchronization process and exits.

**Alias for:** `bun run .server/database/sync/run.ts`

**Behavior:**
- Connects to the database specified by `DB_URL`.
- Creates a backup in `.server/.data/backups/`.
- Computes the diff between `schema.ts` and the live database.
- Executes `CREATE`, `ALTER`, and `DROP` statements to align the database.
- Handles `old()` column/table migrations.

This command is safe to run in CI/CD pipelines before deployment. If the schema is already in sync, it does nothing and exits with code 0.

---

### `bun test`

Runs the standard Bun test runner.

**Behavior:**
- Scans the project for `*.test.ts` or `*.test.tsx` files.
- Executes tests concurrently.
- If `NODE_ENV=test` is set in `.env` (or inline), Bakery binds to port 0 when started within tests, preventing port collisions.

---

## Internal Flags (Advanced)

These flags are passed internally by Bakery scripts and should generally not be used manually:

- `--dev-worker` — Tells the server it is running as the subprocess spawned by the dev master. Triggers the exit-code-42 restart behavior.
- `--smol` — A native Bun flag that reduces V8 memory limits. Bakery's dev master passes this to the worker to keep the development footprint tiny.

---

*[← Compiler & Virtual Assets](../advanced/compiler.md) · [Troubleshooting & FAQ →](./troubleshooting.md)*

*[← Back to README](../../README.md)*
