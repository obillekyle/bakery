import { expect, test, describe, beforeEach } from 'bun:test'
import { HTMLHandler } from '../handlers/routes/html'
import { clearHostConfigCache, initConfig } from '../core/config'

describe('Dynamic Routing & Path Normalization', () => {
  beforeEach(async () => {
    clearHostConfigCache()
    await initConfig()
  })

  test('HTMLHandler resolves dynamic route /blog/123.html to src/blog/[id].html', async () => {
    const route = await HTMLHandler.resolveRoute('/blog/123.html')
    expect(route).not.toBeNull()
    expect(route?.isDynamic).toBeTrue()
    expect(route?.params).toEqual(['id'])
    expect(route?.getParams('/blog/123.html')).toEqual({ id: '123' })
  })

  test('HTMLHandler resolves static route /index.html without dynamic fallback', async () => {
    const route = await HTMLHandler.resolveRoute('/index.html')
    expect(route).not.toBeNull()
    expect(route?.isDynamic).toBeFalse()
  })
})
