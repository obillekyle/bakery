import { Bakery } from '../../core/bakery'

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
  // `Bakery.config`, not `getConfig()`: this runs inside the request's host
  // store, and the process config is the wrong answer under `hosts`. It was
  // the only reader of the two that disagreed — `getHostname` and the
  // session's `Secure` flag both read the host's `trustProxy`, so one host
  // could have its hostname and cookie resolved from its own config while
  // its client IP was resolved from the base one.
  if (!Bakery.config.trustProxy) {
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
