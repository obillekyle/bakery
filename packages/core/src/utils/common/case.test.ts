import { describe, expect, test } from 'bun:test'
import { Case, toHash } from './case'

describe('Case', () => {
  test('toKebabCase', () => {
    expect(Case.kebab('helloWorld')).toBe('hello-world')
    expect(Case.kebab('HelloWorld')).toBe('hello-world')
    expect(Case.kebab('hello_world')).toBe('hello-world')
    expect(Case.kebab('hello world')).toBe('hello-world')
    expect(Case.kebab('already-kebab')).toBe('already-kebab')
  })

  test('toCamelCase', () => {
    expect(Case.camel('hello-world')).toBe('helloWorld')
    expect(Case.camel('hello_world')).toBe('helloWorld')
    expect(Case.camel('hello world')).toBe('helloWorld')
    expect(Case.camel('HelloWorld')).toBe('helloWorld')
    expect(Case.camel('already-camel')).toBe('alreadyCamel')
  })

  test('toPascalCase', () => {
    expect(Case.pascal('hello-world')).toBe('HelloWorld')
    expect(Case.pascal('hello_world')).toBe('HelloWorld')
    expect(Case.pascal('hello world')).toBe('HelloWorld')
    expect(Case.pascal('helloWorld')).toBe('HelloWorld')
  })

  test('toSnakeCase', () => {
    expect(Case.snake('helloWorld')).toBe('hello_world')
    expect(Case.snake('HelloWorld')).toBe('hello_world')
    expect(Case.snake('hello-world')).toBe('hello_world')
    expect(Case.snake('hello world')).toBe('hello_world')
  })

  test('upper/lower/caps', () => {
    expect(Case.upper('hello')).toBe('HELLO')
    expect(Case.lower('HELLO')).toBe('hello')
    expect(Case.caps('hello-world_foo')).toBe('HELLOWORLDFOO')
  })

  test('Case() switch dispatches correctly', () => {
    expect(Case('kebab', 'helloWorld')).toBe('hello-world')
    expect(Case('camel', 'hello-world')).toBe('helloWorld')
    expect(Case('pascal', 'hello-world')).toBe('HelloWorld')
    expect(Case('snake', 'helloWorld')).toBe('hello_world')
  })

  test('Case() unknown type returns input unchanged', () => {
    expect(Case('unknown' as any, 'hello')).toBe('hello')
  })
})

describe('toHash', () => {
  test('returns a base36 string', () => {
    const hash = toHash('test')
    expect(typeof hash).toBe('string')
    expect(hash.length).toBeGreaterThan(0)
  })

  test('same input produces same hash', () => {
    expect(toHash('hello')).toBe(toHash('hello'))
  })

  test('different inputs produce different hashes', () => {
    expect(toHash('hello')).not.toBe(toHash('world'))
  })

  test('empty input generates random hash', () => {
    const h1 = toHash()
    const h2 = toHash()
    expect(h1).not.toBe(h2)
  })
})
