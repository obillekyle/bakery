import { Bakery } from '../../core/bakery'
import { getStatic } from '../core/$static'
import { response } from '../../utils/http'
import { Handler } from '../core/$base'

export class PublicHandler extends Handler {
  static canHandle(path: string) {
    return path.startsWith('/uploads/')
  }

  static async handle(path: string) {
    const resolved = await getStatic(path, Bakery.publicRoot)
    if (!resolved) return response.error('Not Found')

    return Bun.file(resolved.file)
  }
}
