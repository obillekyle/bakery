# create-bakery

The scaffolder behind `bun create bakery`.

```bash
bun create bakery my-app
```

Writes a working [Bakery](https://github.com/obillekyle/bun-server) app: a page,
an API route that round-trips through SQLite, a registered ORM schema, and a
`db:sync` script. Then:

```bash
cd my-app
bun run db:sync
bun run dev
```

## Options

| Flag | Effect |
| --- | --- |
| `--name <name>` | Package name, when it should differ from the directory |
| `--no-install` | Write the files and stop |
| `-h`, `--help` | Usage |

Use `.` as the directory to scaffold in place. The positional argument is a
*path*, so its basename becomes the package name — scoped names come from
`--name`.

It refuses to scaffold into a directory that already has files in it, since that
is not undoable. A bare `.git` directory is ignored, so
`git init && bun create bakery .` works.

## Notes

- **Bun only** — the generated app depends on Bun APIs throughout.
- This package has **no dependencies**, not even on Bakery. It writes files.

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).
