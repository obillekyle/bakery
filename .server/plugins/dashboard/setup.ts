import { bundleModule } from '@server/compiler'
import { Bakery } from '@server/core/bakery'
import { Handler } from '@server/handlers'
import { setLogCallback } from '@server/logger'
import { processBody } from '@server/utils'
import { Try } from '@server/utils/common'
import { FileSystem as fs } from '@server/utils/fs'
import {
  assembleHtml,
  injectIfHtml,
  redirect,
  response,
} from '@server/utils/http'
import { renderLoginForm } from './components/LoginForm'
import {
  handleExecuteAction,
  handleQuery,
  handleSchema,
  handleTableData,
} from './endpoints/database'
import {
  handleDeleteSession,
  handleGetSessions,
  handleUpdateSession,
} from './endpoints/sessions'
import renderDashboardShell from './shell'

export const dashboardConnectedLoggers = new Set<any>()

const isDevWorker = Boolean(import.meta.env.DEV_WORKER && import.meta.env.DEV)
let cachedDashboardJsPath: string | null = null

class DashboardHandler extends Handler {
  static canHandle(path: string) {
    return path.startsWith('/_dashboard') || path.startsWith('/api/_dashboard')
  }

  static resolveRoute(path: string): Handler.Route.Info | null {
    if (path.startsWith('/_dashboard') || path.startsWith('/api/_dashboard')) {
      return new Handler.Route.Info(
        fs.resolve('./.server/plugins/dashboard/setup.tsx'),
        path,
      )
    }
    return null
  }

  static getRegisteredRoutes(): MapOf<Handler.Route.Meta> {
    return {
      '/_dashboard': { type: 'route', isRoot: true, fileName: 'shell.tsx' },
      '/_dashboard/style.css': {
        type: 'static',
        isRoot: false,
        fileName: 'style.css',
      },
      '/_dashboard/dashboard.js': {
        type: 'static',
        isRoot: false,
        fileName: 'dashboard.js',
      },
      '/api/_dashboard/sessions': {
        type: 'endpoint',
        isRoot: false,
        fileName: '_virtual',
      },
      '/api/_dashboard/sessions/delete': {
        type: 'endpoint',
        isRoot: false,
        fileName: '_virtual',
      },
      '/api/_dashboard/sessions/update': {
        type: 'endpoint',
        isRoot: false,
        fileName: '_virtual',
      },
      '/api/_dashboard/schema': {
        type: 'endpoint',
        isRoot: false,
        fileName: '_virtual',
      },
      '/api/_dashboard/table-data': {
        type: 'endpoint',
        isRoot: false,
        fileName: '_virtual',
      },
      '/api/_dashboard/query': {
        type: 'endpoint',
        isRoot: false,
        fileName: '_virtual',
      },
      '/api/_dashboard/execute-action': {
        type: 'endpoint',
        isRoot: false,
        fileName: '_virtual',
      },
    }
  }

  static async handle(
    _path: string,
    req: Request,
  ): Promise<Response | undefined> {
    const res = await handleDashboardRequest(req)
    return res || undefined
  }
}

export function setupDashboard() {
  if (Bakery) {
    Bakery.connectedLoggers = dashboardConnectedLoggers
  }

  setLogCallback(entry => {
    const message = JSON.stringify({
      type: 'server_log',
      level: entry.level,
      by: entry.by,
      payload: entry.msg,
      timestamp: Date.now(),
    })
    dashboardConnectedLoggers.forEach(loggerWs => {
      Try(() => loggerWs.send(message))
    })
  })

  Bakery.handlers.fetch.set(DashboardHandler, 120)
}

async function loginForm(status = 200, errorMessage?: string) {
  const htmlContent = renderLoginForm(errorMessage)
  const injected = await assembleHtml(htmlContent)
  return response.html(injected, status)
}

async function handleLoginPost(req: Request, session: any, dashpass: string) {
  return await Try.return(
    async () => {
      const body = await processBody(req)
      if (body?.password !== dashpass) {
        return await loginForm(200, 'Incorrect password, try again.')
      }
      session.set('dashpassAuthenticated', true)
      return redirect('/_dashboard')
    },
    async () => await loginForm(200, 'Login error. Please try again.'),
  )
}

async function handleDashboardView() {
  const htmlContent = await renderDashboardShell()
  const injected = await injectIfHtml(htmlContent)

  return injected ? injected : response.html(htmlContent)
}

function handleCssAsset() {
  return response.type(
    Bun.file('./.server/plugins/dashboard/client/dashboard.css'),
    'text/css',
  )
}

async function handleJsAsset() {
  if (cachedDashboardJsPath && !isDevWorker) {
    const cachedFile = Bun.file(cachedDashboardJsPath)
    if (cachedFile.size > 0) return response.type(cachedFile, 'text/javascript')
  }

  const bundleResult = await bundleModule(
    './.server/plugins/dashboard/client/dashboard.ts',
  )

  if (!bundleResult.success || !bundleResult.content) {
    console.error('Failed to bundle dashboard.js:', bundleResult.errors)
    return response.error(
      `Failed to bundle dashboard.js: ${bundleResult.errors?.join('\n')}`,
      500,
    )
  }

  if (!isDevWorker) {
    const tmpPath = `${Bakery.cacheDir}/_dashboard.js`
    await Bun.write(tmpPath, bundleResult.content)
    const writtenFile = Bun.file(tmpPath)
    if (writtenFile.size > 0) {
      cachedDashboardJsPath = tmpPath
      return writtenFile
    }
  }

  return response.type(bundleResult.content, 'text/javascript')
}

async function checkAuthMiddleware(
  _req: Request,
  path: string,
  dashpass: string | undefined,
  session: any,
) {
  if (!dashpass) return response.error('Not Found', 404)

  const isAuth = session?.get('dashpassAuthenticated', false) === true
  if (isAuth || /\.(css|js)$/.test(path)) return null

  return path.startsWith('/api/')
    ? response.error('Unauthorized', 401)
    : await loginForm(200, 'Please log in to access the dashboard')
}

const dashboardRoutes: Record<
  string,
  (req: Request, url: URL) => Promise<any> | any
> = {
  '/_dashboard': () => handleDashboardView(),
  '/_dashboard/style.css': () => handleCssAsset(),
  '/_dashboard/dashboard.js': () => handleJsAsset(),
  '/api/_dashboard/sessions': (_req, url) => handleGetSessions(url),
  '/api/_dashboard/sessions/delete': req => handleDeleteSession(req),
  '/api/_dashboard/sessions/update': req => handleUpdateSession(req),
  '/api/_dashboard/schema': () => handleSchema(),
  '/api/_dashboard/table-data': (_req, url) => handleTableData(url),
  '/api/_dashboard/query': req => handleQuery(req),
  '/api/_dashboard/execute-action': req => handleExecuteAction(req),
}

export async function handleDashboardRequest(
  req: Request,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (!path.startsWith('/_dashboard') && !path.startsWith('/api/_dashboard'))
    return null

  const dashpass = process.env.DASHPASS
  const session = req.session

  if (dashpass && path === '/_dashboard/logout') {
    session.set('dashpassAuthenticated', false)
    return redirect('/_dashboard/login')
  }

  if (dashpass && path === '/_dashboard/login' && req.method === 'POST') {
    return handleLoginPost(req, session, dashpass)
  }

  const authBlock = await checkAuthMiddleware(req, path, dashpass, session)
  if (authBlock) return authBlock

  const routeHandler = dashboardRoutes[path]
  if (routeHandler) {
    return await routeHandler(req, url)
  }
  return null
}
