# Setup Guide

This guide outlines the step-by-step instructions to install, configure, and execute the Bakery server.

---

## Prerequisites
The Bakery server framework requires **Bun** to run. Install it using the official command:

*   **macOS/Linux:**
    ```bash
    curl -fsSL https://bun.sh/install | bash
    ```
*   **Windows (PowerShell):**
    ```powershell
    powershell -c "irm https://bun.sh/install.ps1 | iex"
    ```

Verify the installation is successful:
```bash
bun --version
```

---

## 1. Install Dependencies
Run the install script in the project root:
```bash
bun install
```

---

## 2. Configure Environment variables
Create a `.env` file from the template:
*   **PowerShell:** `Copy-Item .env.example .env`
*   **Bash:** `cp .env.example .env`

#### Settings:
*   `PORT` (default `3000`): The network port the server listens on.
*   `DB_URL`: The database connection string (e.g. `postgres://...`, `mysql://...`). If left empty, Bakery defaults to a local SQLite database at `.server/.data/server.db`.
*   `DASHPASS`: Set a password to protect the developer dashboard console (`/_dashboard`).

---

## 3. Sync Database Schema
Apply the typescript database schema to your database before starting the server:
```bash
bun run db:sync
```
This CLI tool reads definitions inside `schema.ts` and syncs table columns and indexes automatically.

---

## 4. Run Development Server
Run the dev task:
```bash
bun run dev
```

*   **Watcher Master**: Reloads the background worker processes automatically when configurations, schemas, or source files change.
*   **Dev Logs Terminal**: Press `d` inside the dev shell to open a separate command console for browser client logs.
*   **DOM LiveReloading**: Automatically patches the client page structure in real-time on HTML, CSS, or TSX file updates.

---

## 5. Serve in Production
Compile scripts and serve in a production environment:
```bash
bun run serve
```
