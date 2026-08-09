import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { Bakery } from '../core/bakery'
import { clearHostConfigCache, initConfig } from '../core/config'
import { HTMLHandler } from '../handlers/routes/html'
import { fs } from '../utils/fs'

// Self-contained fixtures: the demo `src/*.html` pages this test used to rely on
// were deleted when the repo was repurposed, which made it fail for reasons that
// had nothing to do with routing.
const FIXTURE_DIR = fs.resolve(Bakery.root, 'src', '__routetest__')

describe('Dynamic Routing & Path Normalization', () => {
  beforeAll(async () => {
    await initConfig()
    await fs.mkdir(FIXTURE_DIR)
    await Bun.write(fs.resolve(FIXTURE_DIR, '[id].html'), '<h1>Dynamic</h1>')
    await Bun.write(fs.resolve(FIXTURE_DIR, 'static.html'), '<h1>Static</h1>')
    HTMLHandler.initRoutes()
  })

  afterAll(async () => {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true })
    HTMLHandler.initRoutes()
  })

  beforeEach(async () => {
    clearHostConfigCache()
    await initConfig()
  })

  test('HTMLHandler resolves a dynamic route to its [param] file', async () => {
    const route = await HTMLHandler.resolveRoute('/__routetest__/123.html')
    expect(route).not.toBeNull()
    expect(route?.isDynamic).toBeTrue()
    expect(route?.params).toEqual(['id'])
    expect(route?.getParams('/__routetest__/123.html')).toEqual({ id: '123' })
  })

  test('HTMLHandler resolves a static route without falling back to dynamic', async () => {
    const route = await HTMLHandler.resolveRoute('/__routetest__/static.html')
    expect(route).not.toBeNull()
    expect(route?.isDynamic).toBeFalse()
  })
})
