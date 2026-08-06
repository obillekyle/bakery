/**
 * Circular-safe JSON helpers.
 *
 * Three copies of this logic existed: the client `$fmt` formatter, the
 * livereload log serializer, and ad-hoc replacers on the server. They drifted —
 * the `$fmt` one shipped with a one-parameter replacer that made every object
 * render as `""` — so the kernel lives here once and callers layer their own
 * extras on top.
 */

/**
 * Build a `JSON.stringify` replacer that substitutes `'[Circular]'` for repeat
 * references. `extra` runs after the cycle check and can rewrite values further.
 *
 * Note the two-parameter signature: `JSON.stringify` calls a replacer as
 * `(key, value)`, so a single-parameter function silently binds to *key*.
 */
export function circularReplacer(
  extra?: (key: string, value: any) => any,
): (key: string, value: any) => any {
  const seen = new WeakSet<object>()
  return (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return extra ? extra(key, value) : value
  }
}

/**
 * Best-effort string form of any value, safe against cycles and throwing
 * `toJSON`/getters. Primitives pass through `String()` unchanged.
 */
export function safeStringify(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value)
  try {
    return JSON.stringify(value, circularReplacer()) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
