import type { MapOf, RouteBody } from '../types'
import { is } from '../utils/common/misc'
import { Bakery } from './bakery'

type Server = Bun.Server<any>

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

export const Fragment = ({ children }: { children?: any }) =>
  raw(renderChildren([children]))

/**
 * Markup that is already HTML and must not be escaped again.
 *
 * A String subclass rather than a plain string, because `createElement`
 * composes by returning strings: without a marker there is no way to tell
 * "HTML produced by a child component" from "text a user typed". It behaves
 * like a string everywhere (`.trim()`, concatenation, `String()`), so callers
 * are unaffected.
 */
export class SafeHtml extends String {}

/** Mark a string as trusted HTML, exempting it from escaping. */
export function raw(value: unknown): string {
  return new SafeHtml(value ?? '') as unknown as string
}

/** True for markup this module produced, or that a caller vouched for. */
export function isSafeHtml(value: unknown): boolean {
  return value instanceof SafeHtml
}

const TEXT_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeText(value: unknown): string {
  return String(value).replace(/[&<>"']/g, ch => TEXT_ESCAPES[ch] || ch)
}

/**
 * Children are escaped unless they are SafeHtml. Nested `createElement` calls
 * return SafeHtml, so composition still works; a bare string interpolated from
 * data is treated as text, which is the safe default.
 */
function renderChildren(children: any[]): string {
  return children
    .flat(10)
    .map(c => {
      if (c === null || c === undefined || is.boolean(c)) return ''
      return isSafeHtml(c) ? String(c) : escapeText(c)
    })
    .join('')
}

export const createElement = (
  tag: any,
  props: MapOf<any> | null,
  ...children: any[]
): string => {
  if (is.function(tag)) return tag({ ...props, children })

  const childStr = renderChildren(children)

  let attrStr = ''
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'children') continue
    if (value === false || value === null || value === undefined) continue

    if (value === true) {
      attrStr += ` ${key}`
      continue
    }

    let attrKey = key

    if (key === 'className') attrKey = 'class'
    else if (key === 'htmlFor') attrKey = 'for'

    const safeValue = escapeText(value)
    attrStr += ` ${attrKey}="${safeValue}"`
  }

  const isVoid = VOID_ELEMENTS.has(tag)

  return raw(
    isVoid ? `<${tag}${attrStr}>` : `<${tag}${attrStr}>${childStr}</${tag}>`,
  )
}

type RenderFn<P = {}> = (
  req: Request,
  body: RouteBody<P>,
  server: Server,
) => string | Promise<string> | Promise<Response> | Response

/**
 * `<P>` is type-level only — declare the route's params once and `body` is
 * typed inside the render function: `html<{ id: string }>((req, body) => …)`.
 * `RouteBody<{}>` is `MapOf<any>`, so an unparameterised call is unchanged.
 */
export function html<P = {}>(render: RenderFn<P>) {
  return async (req: Request, body: RouteBody<P>) => {
    const rendered = await render(req, body, Bakery.server!)
    const rawDom = rendered instanceof Response ? rendered : String(rendered)

    if (rawDom instanceof Response) {
      return rawDom
    }

    if (rawDom.trim().toLowerCase().startsWith('<html'))
      return `<!DOCTYPE html>\n${rawDom}`
    if (rawDom.trim().toLowerCase().startsWith('<!doctype')) return rawDom

    let title = 'Document'
    const dom = rawDom.replace(/<title>(.*?)<\/title>/i, (_, t) => {
      title = t
      return ''
    })

    return `
          <!DOCTYPE html>
          <html>
            <head>
              <title>${title}</title>
            </head>
            <body>
              ${dom}
            </body>
          </html>
        `
  }
}
