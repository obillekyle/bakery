/**
 * Escaping primitives shared by the server pipeline and the browser runtime.
 *
 * These live in `isomorphic/` because both sides need them: the HTML pipeline
 * and the Vue plugin escape on the way out, and the client bundle escapes when
 * building DOM strings. Nothing here may reference `Bun.*`, node builtins, or
 * DOM globals — this module is compiled into the browser bundle as-is.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escape the five HTML-significant characters. Nullish input yields an empty
 * string rather than throwing, so it is safe to call on optional values.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, char => HTML_ESCAPES[char] || char)
}

/**
 * Serialize for embedding inside a `<script>` tag. Escaping `<` stops a
 * `</script>` in the data from closing the tag; U+2028/2029 are line terminators
 * to a JS parser but legal raw inside JSON.
 *
 * `utils/http/dom.ts` used to carry its own copy of this and is now a caller.
 */
export function escapeScriptJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, val) =>
    val === undefined ? null : val,
  )
  if (json === undefined) return 'null'
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
