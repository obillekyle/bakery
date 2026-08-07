import { compile } from '../../compiler'
import { Bakery, hostKey } from '../../core/bakery'
import { toHash } from '../../utils/common'
import { fs } from '../../utils/fs'
import { response } from '../../utils/http'
import { DynamicHandler } from '../core/$dynamic'

const normalizePath = (path: string) =>
  path.endsWith('.js') ? path.slice(0, -3) : path

export class TSHandler extends DynamicHandler {
  static get config() {
    return {
      ext: ['ts'],
      dir: Bakery.serveRoot,
    }
  }

  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'ts_cache')
  }

  static async canHandle(path: string, req: Request) {
    if (path.endsWith('.ts')) return true
    return await super.canHandle(normalizePath(path), req)
  }

  static async handle(path: string) {
    const info = await this.resolveRoute(normalizePath(path))
    if (!info) return response.error('Not Found')

    const file = info.file
    const id = toHash(hostKey(info.path))
    const cacheName = `${id}.js`
    const fileOrig = fs.resolve(this.config.dir, info.path)

    const cached = await fs.getOrCreateCachedFile(
      this.cacheDir,
      cacheName,
      file.lastModified,
      () => this.compileRoute(fileOrig),
    )

    // 500, not the default 404: the route exists, the server failed to build
    // it, and a 404 sends the developer hunting for a missing file.
    //
    // The route is named because this branch was unreachable until
    // `compileText` stopped throwing past it, and a nameless "Compilation
    // Failed" is only half an answer: the diagnostic — file, line, column,
    // source line — goes to the log as `compLog.COMPILE_FAIL`, and the two
    // have to be joinable. Naming it discloses nothing a client did not
    // already send: `info.path` is what it asked for. In production
    // `publicBody` replaces the whole 5xx body anyway.
    return cached || response.error(`Compilation Failed: ${info.path}`, 500)
  }

  /** Compile seam — ts.test.ts substitutes it to exercise the failure branch. */
  static compileRoute(file: fs.AbsolutePath): Promise<string | null> {
    return compile(file)
  }
}
