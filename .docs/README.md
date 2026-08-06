# Do not use this documentation

This tree describes a **previous architecture** of the framework — a single
`.server/` directory, a root-level `api/`, globally-declared helper types —
none of which exists anymore.

An audit against source found definite factual errors in **33 of the 34 files
here**. Every import path in the code examples (`@server/*`, `@database/*`,
`@plugins/*`) is dead; some documented APIs (e.g. `Bakery.getRequest()`) never
existed in this repo at all.

**The maintained documentation is in [`docs/`](../docs/)**, written from source
and machine-checked: `tests/docs-examples.test.ts` compiles every code block
against the real packages, so a broken example fails the build.

This tree is retained only until `docs/` demonstrably covers its ground, then
it will be deleted.
