import type { Match } from '../../types'

const matchDefault = Symbol('matchDefault')

function handleStringCases(value: any, cases: any): any {
  // hasOwn, not `in`: `in` walks the prototype chain, so match('toString', {…})
  // would find and invoke Object.prototype.toString.
  if (Object.hasOwn(cases, value)) {
    const handler = cases[value]
    return typeof handler === 'function' ? handler(value) : handler
  }
  if (matchDefault in cases) {
    const handler = cases[matchDefault]
    return typeof handler === 'function' ? handler(value) : handler
  }
  return undefined
}

function handleArrayCases(value: any, cases: any[]): any {
  for (const [predicate, result] of cases) {
    const isMatch =
      predicate === match ||
      predicate === matchDefault ||
      predicate === value ||
      (typeof predicate === 'function' && Boolean(predicate(value)))

    if (isMatch) {
      return typeof result === 'function' ? result(value) : result
    }
  }
  return undefined
}

export const match: Match<typeof matchDefault> = ((value: any, cases: any) => {
  const isString = typeof value === 'string'
  const isArray = Array.isArray(cases)

  if (isString && !isArray) {
    return handleStringCases(value, cases)
  }
  if (isArray) {
    return handleArrayCases(value, cases)
  }
  return undefined
}) as any

match.default = matchDefault
match[Symbol.toPrimitive] = () => matchDefault

export { matchDefault }
