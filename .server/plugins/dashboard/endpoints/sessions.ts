import { processBody } from '@server/utils'
import { response } from '@server/utils/http'
import { Session } from '@server/session'

export async function handleGetSessions(url: URL) {
  const search = url.searchParams.get('search')?.trim().toLowerCase() || ''
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
  const pageSize = Math.min(
    500,
    Math.max(1, parseInt(url.searchParams.get('pageSize') || '25', 10)),
  )
  const sortBy = url.searchParams.get('sortBy') || 'accessed'
  const sortOrder = url.searchParams.get('sortOrder') === 'ASC' ? 'ASC' : 'DESC'

  const result = await Session.list({
    search,
    page,
    pageSize,
    sortBy,
    sortOrder,
  })

  return response.json.success('success', result)
}

export async function handleDeleteSession(req: Request) {
  const body = await processBody(req)
  const deleted = body?.id && Session.delete(body.id)
  return deleted
    ? response.json.success('Session deleted')
    : response.json.error(404, 'Session not found')
}

export async function handleUpdateSession(req: Request) {
  const body = await processBody(req)
  const { id, key, value, remove } = body || {}

  if (typeof id !== 'string' || typeof key !== 'string')
    return response.json.error(400, 'Invalid payload')

  const session = await Session.get(id)
  if (!session) return response.json.error(404, 'Session not found')

  remove ? session.delete(key) : session.set(key, value)
  return response.json.success('Session updated', { id, key, value, remove })
}
