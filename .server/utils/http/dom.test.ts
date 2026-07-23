import { describe, test, expect } from 'bun:test'
import { DOMTools, clearHeadBodyCache } from './dom'

describe('DOMTools', () => {
  test('isHTML detects HTML strings', async () => {
    const result = await DOMTools.isHTML('<div>Hello</div>')
    expect(result.content).toBe('<div>Hello</div>')
  })

  test('isHTML returns empty for non-HTML', async () => {
    const result = await DOMTools.isHTML('just plain text')
    expect(result.content).toBe('')
  })

  test('isHTML returns empty for SVG', async () => {
    const result = await DOMTools.isHTML('<?xml version="1.0"?><svg></svg>')
    expect(result.content).toBe('')
  })

  test('isHTML handles Response with HTML content-type', async () => {
    const res = new Response('<p>hi</p>', {
      headers: { 'Content-Type': 'text/html' },
    })
    const result = await DOMTools.isHTML(res)
    expect(result.content).toContain('<p>hi</p>')
  })

  test('isHTML returns empty for non-HTML Response', async () => {
    const res = new Response('data', {
      headers: { 'Content-Type': 'application/json' },
    })
    const result = await DOMTools.isHTML(res)
    expect(result.content).toBe('')
  })

  test('params creates script tag with page params', () => {
    const result = DOMTools.params({ title: 'Hello', count: '5' })
    expect(result).toContain('window.__PAGE_PARAMS__')
    expect(result).toContain('title')
    expect(result).toContain('Hello')
  })

  test('params filters out $$ keys', () => {
    const result = DOMTools.params({ title: 'Hi', $$head: 'skip', $$body: 'skip' })
    expect(result).not.toContain('$$head')
    expect(result).not.toContain('$$body')
    expect(result).toContain('title')
  })
})

describe('clearHeadBodyCache', () => {
  test('clears without error', () => {
    clearHeadBodyCache()
  })
})
