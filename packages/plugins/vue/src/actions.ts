import { Bakery, hostKey } from '@bakery-framework/core/core/bakery'
import { fs, response, toHash } from '@bakery-framework/core/utils'
import type { VueMeta } from './types'
import { collectExportedFunctionNames } from './utils'

export interface ActionTarget {
  id: string
  lastMod: number
  filePath: string
  diskFile: Bun.BunFile
}

/** The parts of a parsed component this gate reads. */
export interface ActionTargetInfo {
  id: string
  meta: VueMeta
  serverScript: string
}

/**
 * Server actions are state-changing and run with the caller's session, so they
 * must not be reachable from a cross-site navigation or a simple form/image
 * request. Requiring POST + JSON puts them outside the set of CORS-simple
 * requests a foreign page can issue without a preflight.
 */
export function validateActionRequest(req: Request, url: URL): Response | null {
  if (req.method !== 'POST') {
    return response.error('Server actions require POST', 405)
  }

  const contentType = req.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    return response.error('Server actions require a JSON body', 415)
  }

  const origin = req.headers.get('origin')
  if (origin && origin !== url.origin) {
    return response.error('Cross-origin server action rejected', 403)
  }

  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return response.error('Cross-site server action rejected', 403)
  }

  return null
}

/**
 * Gate the component a `__vue_action` request will actually execute.
 *
 * `__vue_file` replaces the whole execution target — id, path and server
 * script — so every check that ran against the *route's* descriptor stopped
 * describing the code that runs. The route was gated; the target was not, and
 * `POST /any-public-page?__vue_action=x&__vue_file=admin/Panel.vue` ran
 * `admin/Panel.vue`'s top-level server code with nothing to justify it.
 *
 * A guard: it returns the rejection rather than throwing, and it fails closed
 * on anything it cannot resolve (convention 2).
 */
export function validateActionTarget(
  target: ActionTargetInfo,
  routeId: string,
  actionName: string,
): Response | null {
  // A `page-only` component is a page: reachable at its own route and nowhere
  // else. Naming one in `__vue_file` from a *different* route is the bypass in
  // its clearest form. `module-only` is deliberately not gated the same way —
  // a module exists to be embedded in someone else's page, so its actions are
  // invoked from that page's route by design, and the generated stub does
  // exactly that.
  if (target.meta.pageOnly && target.id !== routeId) {
    return response.error('Not Found', 404)
  }

  // Resolve the name against the *target's* own exports before a line of it
  // runs. The generated wrapper checks this too, but the check reached only
  // after the component's top-level statements had already executed.
  const actions = collectExportedFunctionNames(target.serverScript).filter(
    name => name !== 'middleware' && name !== 'default',
  )

  if (!actions.includes(actionName)) {
    return response.error('Not Found', 404)
  }

  return null
}

/**
 * Resolve the `__vue_file` parameter to a component inside the serve root.
 * The value is attacker-controlled, so containment is checked after resolution
 * rather than by inspecting the raw string.
 */
export async function resolveActionTarget(
  actionFile: string,
): Promise<ActionTarget | null> {
  if (!actionFile.endsWith('.vue')) return null

  const root = fs.resolve(Bakery.serveRoot)
  const resolvedPath = fs.resolve(root, actionFile)

  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}/`)) return null
  if (fs.isForbidden(resolvedPath, root)) return null

  const diskFile = Bun.file(resolvedPath)
  if (!(await diskFile.exists())) return null

  // Same derivation as the page path, so one file never gets two cache ids.
  const relativePath = fs.relative(root, resolvedPath)

  return {
    id: toHash(hostKey(relativePath)),
    lastMod: diskFile.lastModified,
    filePath: resolvedPath,
    diskFile,
  }
}
