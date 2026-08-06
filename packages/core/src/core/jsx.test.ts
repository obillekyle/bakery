import { describe, test, expect, beforeAll, beforeEach } from 'bun:test'
import { initConfig, clearHostConfigCache } from './config'
import { createElement, Fragment, html, raw } from './jsx'

beforeAll(async () => {
  await initConfig()
})

describe('createElement', () => {
  test('creates HTML element from tag string', () => {
    const result = createElement('div', { class: 'box' }, 'hello')
    expect(String(result)).toBe('<div class="box">hello</div>')
  })

  test('creates self-closing void element', () => {
    const result = createElement('br', null)
    expect(String(result)).toBe('<br>')
  })

  test('creates element with boolean attributes', () => {
    const result = createElement('input', { disabled: true })
    expect(String(result)).toContain('disabled')
  })

  test('skips false/null/undefined attributes', () => {
    const result = createElement('div', { id: undefined, class: null } as any, 'text')
    expect(String(result)).not.toContain('id=')
    expect(String(result)).not.toContain('class=')
    expect(String(result)).toContain('text')
  })

  test('converts className to class', () => {
    const result = createElement('div', { className: 'test' })
    expect(String(result)).toContain('class="test"')
  })

  test('converts htmlFor to for', () => {
    const result = createElement('label', { htmlFor: 'name' })
    expect(String(result)).toContain('for="name"')
  })

  test('escapes double quotes in attribute values', () => {
    const result = createElement('div', { title: 'say "hi"' })
    expect(String(result)).toContain('say &quot;hi&quot;')
  })

  test('calls function tag with props', () => {
    const MyComp = (props: any) => `<span>${props.text}</span>`
    const result = createElement(MyComp, { text: 'hi' })
    expect(String(result)).toBe('<span>hi</span>')
  })

  test('escapes plain-string children rather than trusting them as markup', () => {
    const result = createElement('ul', null, '<li>a</li>', '<li>b</li>')
    // A bare string is data, not markup — this is the safe default.
    expect(String(result)).toBe(
      '<ul>&lt;li&gt;a&lt;/li&gt;&lt;li&gt;b&lt;/li&gt;</ul>',
    )
  })

  test('raw() opts a string back into being markup', () => {
    const result = createElement('ul', null, raw('<li>a</li>'), raw('<li>b</li>'))
    expect(String(result)).toBe('<ul><li>a</li><li>b</li></ul>')
  })

  test('handles nested children', () => {
    const result = createElement('div', null,
      createElement('span', null, 'one'),
      createElement('span', null, 'two'),
    )
    expect(String(result)).toContain('<span>one</span>')
    expect(String(result)).toContain('<span>two</span>')
  })

  test('filters out null/undefined/boolean children', () => {
    const result = createElement('div', null, null, undefined, false, 'keep')
    expect(String(result)).toBe('<div>keep</div>')
  })
})

describe('Fragment', () => {
  test('joins children array', () => {
    const result = Fragment({ children: ['a', 'b', 'c'] })
    expect(String(result)).toBe('abc')
  })

  test('returns empty for no children', () => {
    const result = Fragment({ children: undefined })
    expect(String(result)).toBe('')
  })

  test('flattens nested arrays', () => {
    const result = Fragment({ children: [['a', 'b'], 'c'] })
    expect(String(result)).toBe('abc')
  })
})

describe('html', () => {
  test('wraps content in DOCTYPE html', async () => {
    const render = html(() => '<div>hi</div>')
    const result = await render(new Request('http://localhost/'), {})
    expect(String(result)).toContain('<!DOCTYPE html>')
    expect(String(result)).toContain('<div>hi</div>')
  })

  test('preserves existing DOCTYPE', async () => {
    const render = html(() => '<!DOCTYPE html><html><body>hi</body></html>')
    const result = await render(new Request('http://localhost/'), {})
    expect(String(result)).toContain('<!DOCTYPE html>')
  })

  test('passes through Response objects', async () => {
    const render = html(() => new Response('raw'))
    const result = await render(new Request('http://localhost/'), {})
    expect(result).toBeInstanceOf(Response)
  })

  test('extracts title from content', async () => {
    const render = html(() => '<div><title>My Page</title>content</div>')
    const result = await render(new Request('http://localhost/'), {}) as string
    expect(String(result)).toContain('<title>My Page</title>')
    expect(String(result)).not.toContain('<title>Document</title>')
  })
})
