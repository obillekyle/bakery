import { describe, expect, test } from 'bun:test'
import {
  ApiHandler,
  GoogleFontHandler,
  Handler,
  HTMLHandler,
  ImageHandler,
  MiddlewareHandler,
  NMHandler,
  ProxyHandler,
  PublicHandler,
  StaticHandler,
  TSHandler,
  TSXHandler,
  VirtualAssetHandler,
} from '.'

/**
 * Which built-in handlers serve assets, the requests the rate limiter stops
 * counting once a URL has been served (`Handler.isAsset`).
 *
 * Each `false` here is a decision, not an omission, and the reason is beside
 * it: a handler moved to the other list must be one whose successful answer
 * costs about a file read, with first-request work bounded by the app's own
 * files.
 */
const req = new Request('http://localhost/x')

describe('Handler.isAsset', () => {
  test('files, compiled modules and bundled packages are assets', () => {
    const assets: (typeof Handler)[] = [
      StaticHandler,
      PublicHandler,
      NMHandler,
      VirtualAssetHandler,
      TSHandler,
    ]
    for (const handler of assets) {
      expect([handler.name, handler.isAsset('/x', req)]).toEqual([
        handler.name,
        true,
      ])
    }
  })

  test('handlers that mint work per URL or run app code are not', () => {
    const counted: (typeof Handler)[] = [
      // Each new size in the query is a new resize.
      ImageHandler,
      // Each new family is a fetch from Google.
      GoogleFontHandler,
      // A page is what a visit is counted by; routes, proxies and middleware
      // run app code on every request.
      TSXHandler,
      HTMLHandler,
      ApiHandler,
      ProxyHandler,
      MiddlewareHandler,
    ]
    for (const handler of counted) {
      expect([handler.name, handler.isAsset('/x', req)]).toEqual([
        handler.name,
        false,
      ])
    }
  })

  test('a handler that says nothing counts, so a plugin opts in', () => {
    class PluginHandler extends Handler {}
    expect(PluginHandler.isAsset('/x', req)).toBe(false)
  })
})
