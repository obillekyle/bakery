/**
 * Serve `docs/` as the published site does, for checking the page itself.
 *
 * The site is a single static HTML file with no build step — GitHub Pages hands
 * out `docs/index.html` and the markdown beside it verbatim. This is the same
 * arrangement over localhost, so what renders here is what renders there.
 *
 * Not part of the build or the test suite. `bun run scripts/serve-docs.ts`.
 */
const ROOT = `${import.meta.dir}/../docs`
const PORT = Number(process.env.DOCS_PORT ?? 3215)

Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url)
    const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)

    // Contain the path: this serves a directory of documentation, and `..` in a
    // request must not walk out of it even on a throwaway local server.
    const resolved = `${ROOT}${rel}`.replace(/\\/g, '/')
    if (!resolved.startsWith(ROOT.replace(/\\/g, '/'))) {
      return new Response('Forbidden', { status: 403 })
    }

    const file = Bun.file(resolved)
    if (await file.exists()) return new Response(file)
    return new Response('Not found', { status: 404 })
  },
})

console.log(`docs on http://localhost:${PORT}`)
