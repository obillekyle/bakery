function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

function toCamelCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[A-Z]/, match => match.toLowerCase())
}

function toPascalCase(str: string): string {
  const camel = toCamelCase(str)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

type CaseType = 'kebab' | 'camel' | 'pascal' | 'snake'

export const Case = Object.assign(
  function Case(type: CaseType, str: string): string {
    switch (type) {
      case 'kebab':
        return toKebabCase(str)
      case 'camel':
        return toCamelCase(str)
      case 'pascal':
        return toPascalCase(str)
      case 'snake':
        return toSnakeCase(str)
      default:
        return str
    }
  },
  {
    kebab: toKebabCase,
    camel: toCamelCase,
    pascal: toPascalCase,
    snake: toSnakeCase,
    upper: (str: string) => str.toUpperCase(),
    lower: (str: string) => str.toLowerCase(),
    caps: (str: string) => str.toUpperCase().replace(/[\s_-]+/g, ''),
  },
)
