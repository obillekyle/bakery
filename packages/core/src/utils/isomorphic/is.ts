/**
 * Type predicates, shared by the server and the browser bundle.
 *
 * Two implementations of this used to exist. This one keeps the *callable*
 * shape from the client copy (`is(x, 'string')` as well as `is.string(x)`,
 * which is what the global `ISFunction` type has always described) and the
 * *semantics* of the server copy — notably `is.object([]) === true`, which
 * `misc.test.ts` asserts and which callers like `router.ts` rely on to
 * JSON-encode array response bodies.
 */

const checks = {
  string: (v: any): v is string => typeof v === 'string',
  number: (v: any): v is number => typeof v === 'number',
  boolean: (v: any): v is boolean => typeof v === 'boolean',
  bigint: (v: any): v is bigint => typeof v === 'bigint',
  symbol: (v: any): v is symbol => typeof v === 'symbol',
  function: (v: any): v is Function => typeof v === 'function',
  /** Arrays count as objects here — see the note above before changing this. */
  object: (v: any): v is Record<string, any> =>
    v !== null && typeof v === 'object',
  array: Array.isArray,
  null: (v: any): v is null => v === null,
  undefined: (v: any): v is undefined => v === undefined,
}

export const is: ISFunction = Object.assign(function is(
  value: any,
  type?: string,
) {
  if (!type) return value !== null && value !== undefined
  // Delegate to the table rather than falling through to `typeof`, so that
  // is(null, 'object') agrees with is.object(null) instead of contradicting it.
  const check = (checks as any)[type]
  return check ? check(value) : typeof value === type
}, checks) as ISFunction
