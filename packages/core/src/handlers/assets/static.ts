import { Bakery, hostKey } from '../../core/bakery'
import { matchBlockedCached } from '../../core/context'
import { toHash } from '../../utils'
import { fs } from '../../utils/fs'
import { injectBrand, response } from '../../utils/http'
import { Handler } from '../core/$base'
import { ErrorHandler } from '../core/$error'
import { getStatic } from '../core/$static'

export class StaticHandler extends Handler {
  static canHandle(): boolean {
    return true
  }

  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'static')
  }

  static async handle(path: string) {
    // The router already ran this for every file-serving handler, but this
    // check must stay: direct callers (tests, embedders) reach `handle`
    // without the router gate. `matchBlockedCached` makes the overlap cost a
    // per-request map hit rather than a second pair of glob matches.
    // One read of the config getter: `blocked` and the serve root come from
    // the same snapshot — getStatic's default `roots` would re-read it.
    const cfg = Bakery.config
    if (matchBlockedCached(cfg.blocked, path)) {
      return response.error('Forbidden', 403)
    }

    const resolved = await getStatic(path, cfg.root)
    if (!resolved) return response.error('Not Found')

    const file = Bun.file(resolved.file)
    const ext = fs.parse(path).ext

    if (fs.isCompressible(ext)) {
      const cacheName = `${toHash(hostKey(path))}${ext}`
      const cached = await fs.getOrCreateCachedFile(
        this.cacheDir,
        cacheName,
        file.lastModified,
        () => file.arrayBuffer(),
      )

      if (cached) return cached
    }

    return file
  }
}

export class DefaultErrorHandler extends ErrorHandler {
  /**
   * This is the fallback for every path with no more specific error handler,
   * so it renders through the inherited `publicBody` like the rest of the
   * error surface — `errorBody` carries the thrown error's stack (that is
   * what the log wants), and handing it to the client verbatim gave any
   * anonymous request source paths and query text in PROD.
   *
   * Two pages, split on the same gate `publicBody` uses, failing the same
   * direction: only an explicit DEV gets the diagnostics page, so an
   * indeterminate mode discloses nothing. DEV keeps the branded title, the
   * body in a `<pre>`, and the requester/date footer — and `processResponse`
   * injects the import map and live reload into it like any page, which is
   * what makes the overlay work on an error. The production page is the
   * status line and the public body, nothing else: the footer echoed the
   * requester's own IP and a server timestamp to anyone who triggered an
   * error, and the page is branded with `injectBrand` because the injected
   * import map names every installed package — see the note on the export.
   */
  static handle(_path: string, req: Request, error?: Handler.Error.Data) {
    error ||= this.DEFAULT_ERROR

    // No separator without text to separate — an empty-message denial used to
    // render `<h1>403 - </h1>`. Same rule for the body below: empty renders
    // as no element, not as a dangling `<pre></pre>`.
    const heading = Bun.escapeHTML(
      error.errorText
        ? `${error.errorCode} - ${error.errorText}`
        : `${error.errorCode}`,
    )
    const body = this.publicBody(error)

    if (import.meta.env.DEV) {
      const ip = Bakery.server?.requestIP(req)?.address || 'Unknown'
      const date = new Date().toDateString()

      const errorPage = `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Error ${error.errorCode} | Bakery 🚀</title>
          </head>
          <body style="margin: 2rem; font-family: sans-serif;">
            <h1>${heading}</h1>
            ${body ? `<pre>${Bun.escapeHTML(body)}</pre>` : ''}
            <hr />
            <small>${Bun.escapeHTML(date)} - ${Bun.escapeHTML(ip)}</small>
          </body>
        </html>
      `

      return response.html(errorPage, error.errorCode)
    }

    // `<p>`, not `<pre>`: outside DEV the body is prose by construction —
    // `publicBody` replaces a 5xx stack with the generic sentence, and a 4xx
    // body is authored text.
    const errorPage = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Error ${error.errorCode}</title>
        </head>
        <body style="margin: 2rem; font-family: sans-serif;">
          <h1>${heading}</h1>
          ${body ? `<p>${Bun.escapeHTML(body)}</p>` : ''}
        </body>
      </html>
    `

    return injectBrand(response.html(errorPage, error.errorCode))
  }
}
