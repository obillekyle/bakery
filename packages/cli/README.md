# @bakery/cli

The `bakery` binary: process-mode dispatch, the dev watcher, and clustering for
[Bakery](https://github.com/obillekyle/bun-server).

**Bun only.** Ships TypeScript source with no build step.

```bash
bun add @bakery/cli
```

## Usage

```json
{
  "scripts": {
    "dev": "bakery --dev",
    "start": "bakery"
  }
}
```

| Command | Mode |
| --- | --- |
| `bakery --dev` | Dev server: file watcher, live reload, on-demand compile |
| `bakery` | Production |
| `bakery --threads 4` | Production cluster of 4 workers (ignored under `--dev`) |
| `bakery --sync` | Run schema sync, **then boot**. Not a standalone sync |

There is no `--port` flag. The port resolves as `PORT` → `port` in
`server.config.ts` → `3000`. A malformed `PORT` is a boot error rather than a
fallback: `PORT=3000x` exits 1 instead of binding somewhere random.

For a standalone schema sync in a deploy step, drive `SyncService` from
`@bakery/orm/sync` directly — `--sync` starts a server afterwards.

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).
