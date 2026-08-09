# @bakery-framework/cli

The `bakery` binary: process-mode dispatch, the dev watcher, and clustering for
[Bakery](https://github.com/obillekyle/bakery).

**Bun only.** Ships TypeScript source with no build step.

```bash
bun add @bakery-framework/cli
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
`@bakery-framework/orm/sync` directly — `--sync` starts a server afterwards.

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).

**Not an OSI-approved licence.** The Commons Clause removes the right to *sell*
the software — meaning to charge for a product or service whose value derives
substantially from it, hosting and support included. Everything else the MIT
licence grants is unchanged: use it, modify it, ship it inside your own product.
If your organisation only permits OSI-approved dependencies, this will not pass
that check.
