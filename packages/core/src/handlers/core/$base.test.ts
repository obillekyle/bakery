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

describe('getDynamicRoute — catch-all segments', () => {
  test('a terminal [...name] compiles to a multi-segment matcher', () => {
    const route = getDynamicRoute('docs/[...slug].tsx')
    expect(route).not.toBeNull()
    expect(route!.params).toEqual(['slug'])
    expect(route!.catchAll).toBe(true)
    expect(route!.pattern.test('/docs/a')).toBe(true)
    expect(route!.pattern.test('/docs/a/b/c')).toBe(true)
    expect(route!.pattern.test('/docs/')).toBe(false)
    expect(route!.pattern.test('/docs')).toBe(false)
    expect(route!.pattern.test('/other/a')).toBe(false)
  })

  test('the captured value is the joined rest of the path', () => {
    const info = new RouteData.Info(
      '/x/docs/[...slug].tsx' as any,
      'docs/[...slug].tsx',
    )
    expect(info.isDynamic).toBe(true)
    expect(info.catchAll).toBe(true)
    expect(info.getParams('/docs/guides/routing')).toEqual({
      slug: 'guides/routing',
    })
    expect(info.getParams('/docs/a')).toEqual({ slug: 'a' })
  })

  test('a catch-all may follow single-param segments', () => {
    const route = getDynamicRoute('api/[version]/[...rest].ts')
    expect(route).not.toBeNull()
    expect(route!.params).toEqual(['version', 'rest'])
    const m = '/api/v2/users/42/posts'.match(route!.pattern)
    expect(m?.[1]).toBe('v2')
    expect(m?.[2]).toBe('users/42/posts')
  })

  test('a non-terminal [...name] is not a dynamic route', () => {
    // Ambiguous placement: nothing may follow a catch-all. The file stays
    // inert (same as before the feature) rather than guessing.
    expect(getDynamicRoute('docs/[...slug]/extra.tsx')).toBeNull()
  })

  test('single-param routes do not become catch-alls', () => {
    const route = getDynamicRoute('blog/[id].html')
    expect(route!.catchAll).toBeFalsy()
    expect(route!.pattern.test('/blog/a/b')).toBe(false)
  })
})
