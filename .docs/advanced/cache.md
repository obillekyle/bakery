# Cache System

Bakery uses a multi-layered caching architecture to ensure high performance while maintaining memory limits. The cache system is split into two primary implementations: the basic `LRUCache` and the persistent `TieredCache`.

---

## LRUCache

The `LRUCache` (Least Recently Used) is a pure in-memory cache used for fast, ephemeral lookups. When the cache reaches its maximum size, the least recently accessed item is evicted (deleted permanently) to make room for new items.

### Usage in Bakery

- **Route Lookups**: Every `DynamicHandler` (TSX, API, HTML, Static) maintains an LRUCache of resolved route paths to file info. This avoids hitting the filesystem `stat` on every request for known routes. The size is controlled by `maxCacheSize` in `server.config.ts`.
- **Image Optimization**: The `ImageHandler` caches optimized image buffers in memory using an LRUCache to avoid re-compressing the same image repeatedly.

### API

```typescript
import { LRUCache } from '@server/cache/lru'

const cache = new LRUCache<string, any>(100) // max 100 items

cache.set('key1', { data: 1 })
const item = cache.get('key1')  // Promotes 'key1' to most recently used
cache.has('key2')               // -> false
cache.delete('key1')
cache.clear()
```

---

## TieredCache

The `TieredCache` extends `LRUCache` to add a durable backing store using SQLite. It is designed for data that is too large to keep entirely in memory, or data that must survive server restarts (like user sessions).

### How It Works

1. **Memory First**: All reads and writes happen in the fast LRU memory tier.
2. **Eviction to Disk**: When the memory tier reaches its maximum size, the oldest 10% of items are evicted from memory but are **not** permanently deleted. Instead, they are flushed to the SQLite backing store.
3. **Rehydration**: If a requested item is not in memory but exists in SQLite, it is pulled back into memory, promoted to the most recently used spot, and returned.
4. **Periodic Flush**: To ensure data durability against crashes, modified items in memory are periodically flushed to SQLite in the background (e.g., every 30 seconds).

### Usage in Bakery

- **Sessions**: User sessions use a `TieredCache`. Active sessions stay in memory; idle sessions are evicted to SQLite but can be instantly restored if the user returns weeks later.
- **Compiled Assets**: Transpiled browser TypeScript (`.ts`) and CSS virtual modules are cached here. This prevents recompilation on server restart.

### API

```typescript
import { TieredCache } from '@server/cache/tiered'

const sessionCache = new TieredCache<string, Session>({
  name: 'sessions',            // Used for SQLite table name and file
  maxSize: 1000,               // Max items in memory
  flushInterval: 30_000,       // Auto-flush every 30s
  filter: (val) => val.hasData // Only persist non-empty sessions
})

await sessionCache.init()      // Must be initialized to create tables

// Normal Map-like operations (sync)
sessionCache.set('user:1', sessionObj)
const s = sessionCache.get('user:1') // May trigger async rehydration under the hood

// Force flush to SQLite
await sessionCache.flush()
```

### Backing Store Location

Tiered caches store their SQLite files in the `.server/.cache/` directory.

- Sessions: `.server/.cache/sessions.json` (actually a SQLite DB)
- Compiled Assets: `.server/.cache/compile.json` (actually a SQLite DB)

These files are distinct from your application's main database (`.server/database/server.db`) and are safe to delete if you want to clear the server's internal caches.

---

*[← Handler Architecture](./handler-architecture.md) · [Compiler & Virtual Assets →](./compiler.md)*

*[← Back to README](../../README.md)*
