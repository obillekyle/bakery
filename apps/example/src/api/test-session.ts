import { response } from '@bakery-framework/core'
import { Session } from '@bakery-framework/core/session'

export default function TestSessionApi(req: Request) {
  req.session = new Session()
  req.session.set('foo', 'bar')
  return response.json(200, `Session created with the id ${req.session.id}`)
}
