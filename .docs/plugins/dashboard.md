# Built-in: Dashboard Plugin

The Dashboard plugin provides a browser-based admin panel accessible at `/_dashboard`. It includes a real-time server overview, session management, a database browser, and (when combined with the Analytics plugin) traffic charts.

---

## Enabling the Plugin

```typescript
// server.config.ts
import { defineConfig } from '@server/core'
import dashboardPlugin from '@plugins/dashboard'
import analyticsPlugin from '@plugins/analytics'

export default defineConfig({
  plugins: [
    dashboardPlugin(),
    analyticsPlugin(),  // optional — enables analytics tab
  ],
})
```

---

## Accessing the Dashboard

Navigate to `http://localhost:3000/_dashboard` in your browser.

If `DASHPASS` is set in your `.env`, the dashboard is protected with HTTP Basic Authentication. The username is ignored — only the password matters.

```ini
# .env
DASHPASS=my_secure_password
```

---

## Dashboard Sections

### Overview

- Server version and uptime
- Current mode (development / production)
- Memory usage
- Active session count
- Request rate (requests/second)
- Registered routes summary

### Sessions

- List all active sessions with ID, created/accessed timestamps, and data
- Search and sort by ID, key count, created date, or last access
- Inspect session data in a collapsible JSON viewer
- Delete individual sessions

### Database Browser

The database browser allows you to:
- Browse all tables in your schema
- Run raw SQL queries in the browser
- View table row counts
- Inspect column definitions and index information
- Export query results as JSON

### Logs (Live)

When a browser window is connected to the dashboard and subscribed to the logger (via the analytics plugin's `connectedLoggers`), real-time server logs are displayed in a scrollable terminal view. This includes:

- HTTP request logs (method, path, status, duration)
- Server events (startup, restart, shutdown)
- Error traces
- Forwarded browser `console.*` output (via the livereload connection)

---

## Security

### Authentication

Set `DASHPASS` in your environment to require a password:

```ini
DASHPASS=your_password
```

Without `DASHPASS`, the dashboard is publicly accessible. **Always set a password in production.**

### Path Protection

The `/_dashboard` path is handled by the dashboard plugin's `onRequest` hook. Requests that fail authentication receive a `401 Unauthorized` response with a `WWW-Authenticate: Basic realm="Bakery Dashboard"` header, triggering the browser's built-in auth dialog.

### Blocking the Dashboard in Production

To disable the dashboard entirely in production without removing the plugin:

```typescript
dashboardPlugin({
  enabled: process.env.NODE_ENV !== 'production',
})
```

Or simply do not register the plugin in your production `server.config.ts`.

---

## Custom Dashboard Tabs (Advanced)

The dashboard is built as a TSX application inside `.server/plugins/dashboard/`. To add custom tabs, you can extend the dashboard's client-side TSX by modifying `.server/plugins/dashboard/setup.tsx`. This is an advanced modification not covered by the standard plugin API.

---

*[← Analytics Plugin](./analytics.md) · [Building for Production →](../deployment/production.md)*

*[← Back to README](../../README.md)*
