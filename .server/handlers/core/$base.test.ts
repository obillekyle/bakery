import { describe, test, expect } from 'bun:test'
import { Handler, getDynamicRoute, RouteData } from './$base'

describe('getDynamicRoute', () => {
  test('returns null for static path', () => {
    expect(getDynamicRoute('blog/post')).toBeNull()
  })

  test('returns null for empty path', () => {
    expect(getDynamicRoute('')).toBeNull()
    expect(getDynamicRoute('/')).toBeNull()
  })

  test('detects single dynamic segment', () => {
    const route = getDynamicRoute('[id]')
    expect(route).not.toBeNull()
    expect(route!.params).toEqual(['id'])
    expect(route!.pattern.test('/42')).toBe(true)
    expect(route!.pattern.test('/abc')).toBe(true)
    expect(route!.pattern.test('/')).toBe(false)
  })

  test('detects multiple dynamic segments', () => {
    const route = getDynamicRoute('blog/[category]/[slug]')
    expect(route).not.toBeNull()
    expect(route!.params).toEqual(['category', 'slug'])
    expect(route!.pattern.test('/blog/tech/my-post')).toBe(true)
    expect(route!.pattern.test('/blog/')).toBe(false)
  })

  test('handles extension in dynamic route', () => {
    const route = getDynamicRoute('[id].html')
    expect(route).not.toBeNull()
    expect(route!.pattern.test('/123.html')).toBe(true)
    expect(route!.pattern.test('/123')).toBe(true)
  })
})

describe('RouteData.Info', () => {
  test('parses static path correctly', () => {
    const info = new RouteData.Info('/some/file.html' as any, 'some/file.html')
    expect(info.isDynamic).toBe(false)
    expect(info.params).toEqual([])
    expect(info.regex).toBeNull()
  })

  test('parses dynamic path correctly', () => {
    const info = new RouteData.Info('/some/[id].html' as any, 'some/[id].html')
    expect(info.isDynamic).toBe(true)
    expect(info.params).toEqual(['id'])
    expect(info.regex).not.toBeNull()
  })

  test('getParams extracts values from path', () => {
    const info = new RouteData.Info('/blog/[id].html' as any, 'blog/[id].html')
    const params = info.getParams('/blog/42.html')
    expect(params).toEqual({ id: '42' })
  })

  test('getParams returns null for non-matching path', () => {
    const info = new RouteData.Info('/blog/[id].html' as any, 'blog/[id].html')
    expect(info.getParams('/other/42')).toBeNull()
  })

  test('getParams returns null for static routes', () => {
    const info = new RouteData.Info('/page.html' as any, 'page.html')
    expect(info.getParams('/page.html')).toBeNull()
  })
})
