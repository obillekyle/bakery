# create-bakery

The scaffolder behind `bun create bakery`.

```bash
bun create bakery my-app
```

Leave out the directory and it asks for one, offering `bakery-app`. At a
terminal it also asks whether to include the ORM and which plugins to add,
unless a flag already said.

Writes a working [Bakery](https://github.com/obillekyle/bakery) app: a page,
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
| `--orm` / `--no-orm` | Include the ORM (`orm/`, `db:sync`), or leave it out |
| `--plugins <list>` | Comma-separated from `vue`, `analytics`, `dashboard`, `db-explorer`, or `none` |
| `--name <name>` | Package name, when it should differ from the directory |
| `--yes`, `-y` | Take the defaults for anything not passed: `bakery-app`, the ORM in, no plugins |
| `--no-install` | Write the files and stop |
| `-h`, `--help` | Usage |

Use `.` as the directory to scaffold in place. The positional argument is a
*path*, so its basename becomes the package name: scoped names come from
`--name`.

It refuses to scaffold into a directory that already has files in it, since that
is not undoable. A bare `.git` directory is ignored, so
`git init && bun create bakery .` works.

## Notes

- **Bun only**: the generated app depends on Bun APIs throughout.
- This package has **no dependencies**, not even on Bakery. It writes files.

## License

MIT with the Commons Clause v1.0. See [LICENSE](./LICENSE).

**Not an OSI-approved license.** The Commons Clause removes the right to *sell*
the software: meaning to charge for a product or service whose value derives
substantially from it, hosting and support included. Everything else the MIT
license grants is unchanged: use it, modify it, ship it inside your own product.
If your organization only permits OSI-approved dependencies, this will not pass
that check.
