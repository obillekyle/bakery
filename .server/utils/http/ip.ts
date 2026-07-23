import { Bakery } from '@server/core/bakery'
import { getConfig } from '@server/core/config'

const TRUSTED_HEADERS = [
  'cf-connecting-ip',
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'fastly-client-ip',
  'true-client-ip',
  'x-forwarded',
  'forwarded-for',
  'forwarded',
]

export function getClientIp(req: Request): string {
  if (!getConfig().trustProxy) {
    return Bakery.server?.requestIP(req)?.address || ''
  }
  for (const header of TRUSTED_HEADERS) {
    const value = req.headers.get(header)
    if (!value) continue
    const first = value.split(',')[0].trim()
    if (first) return first
  }
  return Bakery.server?.requestIP(req)?.address || ''
}
