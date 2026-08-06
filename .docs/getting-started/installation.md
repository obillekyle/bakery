# Prerequisites & Installation

This guide walks you through getting Bakery running on your machine from scratch.

---

## Prerequisites

### Bun ≥ 1.0.0

Bakery requires [Bun](https://bun.sh) as its JavaScript/TypeScript runtime. Bun replaces Node.js, npm, and a bundler in a single binary.

**Install Bun:**

```bash
# macOS / Linux (via curl)
curl -fsSL https://bun.sh/install | bash

# Windows (via PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# via npm (cross-platform)
npm install -g bun
```

**Verify your installation:**

```bash
bun --version
# → 1.x.x
```

### TypeScript ≥ 6.0

Bakery's `package.json` lists TypeScript as a peer dependency. Install it in your project:

```bash
bun add -d typescript
```

> **Note:** TypeScript is only needed for editor tooling and type-checking. The runtime uses Bun's built-in TypeScript transpiler and does not invoke `tsc` at startup.

---

## Getting Bakery

Bakery is structured as a project template rather than a CLI-installable package. Clone or copy the repository into your working directory.

```bash
# Clone the repository
git clone https://github.com/obillekyle/bun-server bakery-app
cd bakery-app

# Install dev dependencies (types only)
bun install
```

The core server lives entirely inside the `.server/` directory. Your application code lives in `src/` (or whichever directory you set as `root` in `server.config.ts`).

---

## Running the Server

### Development Mode

```bash
bun run dev
```

This starts the dev master process which:

1. Spawns a worker subprocess that runs the actual HTTP server.
2. Watches the filesystem for changes.
3. On backend file changes (`.server/`, `api/`, `schema.ts`, `server.config.ts`, `*.tsx`) — restarts the worker with exit code `42`.
4. On frontend file changes (`.html`, `.css`, `.ts`) — notifies connected browsers via WebSocket.
5. On `package.json` / `bun.lock` changes — logs a notice to reinstall dependencies.

**Dev keyboard shortcuts (when stdin is a TTY):**

| Key | Action |
|-----|--------|
| `s` | Gracefully stop the server |
| `d` | Spawn a detached logger terminal |
| `Ctrl+C` | Kill the worker process |

### Production Mode

```bash
bun run serve
```

Starts the server directly without the watcher layer. The `import.meta.env.DEV` flag is `false`, live reload is disabled, and assets are minified by the compiler.

### Database Schema Sync

```bash
bun run db:sync
```

Runs the database schema synchronization in isolation (without starting the HTTP server). Useful in CI/CD pipelines before deployment.

### Tests

```bash
bun test
```

Runs Bun's built-in test runner against any `*.test.ts` files in the project.

---

## Environment Setup

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your values. The server reads from `.env` automatically via Bun's built-in dotenv support.

```ini
# .env
DASHPASS=your_secure_password   # Dashboard login password
DB_URL=                          # Leave blank for SQLite (default)
PORT=3000                        # Override server port (optional)
```

See [Environment Variables →](../configuration/environment-variables.md) for the full reference.

---

## Verifying the Installation

Once the server is running, open your browser:

- **Application:** `http://localhost:3000`
- **Dashboard:** `http://localhost:3000/_dashboard` *(if `dashboardPlugin()` is registered)*

You should see the content from `src/index.html` (or your configured `root` directory).

---

## Troubleshooting

If you encounter errors on first run:

1. **`Config init failed`** — check that `server.config.ts` exists at the project root.
2. **`Startup failed` (database)** — check that `schema.ts` exports `DBInfo.constraints` correctly.
3. **Port already in use** — set a different port via `PORT=3001 bun run dev`.

See the full [Troubleshooting Guide →](../reference/troubleshooting.md).

---

*[← Introduction](./introduction.md) · [Project Structure →](./project-structure.md)*

*[← Back to README](../../README.md)*
