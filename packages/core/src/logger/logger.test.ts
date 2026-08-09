import { describe, expect, test } from 'bun:test'
import { Logger, log, messageLogger, setLogCallback } from './logger'

describe('Logger class', () => {
  test('constructs with by name', () => {
    const logger = new Logger('test-module')
    expect(logger).toBeDefined()
  })

  test('log method calls without error', () => {
    const logger = new Logger('test')
    expect(() => logger.log('hello')).not.toThrow()
  })

  test('log with level parameter', () => {
    const logger = new Logger('test')
    expect(() => logger.log('warn msg', 'warn')).not.toThrow()
    expect(() => logger.log('error msg', 'error')).not.toThrow()
    expect(() => logger.log('debug msg', 'debug')).not.toThrow()
  })
})

describe('log function', () => {
  test('logs with default values', () => {
    expect(() => log({ msg: 'test message' })).not.toThrow()
  })

  test('logs with all level types', () => {
    const levels = ['info', 'warn', 'error', 'fatal', 'debug', 'trace'] as const
    for (const level of levels) {
      expect(() => log({ level, msg: `test ${level}` })).not.toThrow()
    }
  })
})

describe('setLogCallback', () => {
  test('callback receives log entries', () => {
    let received: any = null
    setLogCallback(entry => {
      received = entry
    })
    log({ msg: 'callback test', by: 'test' })
    expect(received).not.toBeNull()
    expect(received.msg).toBe('callback test')
    expect(received.by).toBe('test')
    // cleanup
    setLogCallback(() => {})
  })
})

describe('messageLogger', () => {
  test('creates proxy-based logger', () => {
    const logger = new Logger('test')
    const msgs = {
      GREET: 'I Hello {name}!',
      ERROR: 'E Something failed: {reason}',
    }
    const ml = messageLogger(logger, msgs)
    expect(ml).toBeDefined()
  })

  test('interpolates params in templates', () => {
    let lastMsg = ''
    const logger = new Logger('test')
    setLogCallback(entry => {
      lastMsg = entry.msg
    })

    const msgs = {
      GREET: 'I Hello {name}!',
    }
    const ml = messageLogger(logger, msgs) as any
    ml.GREET({ name: 'World' })
    expect(lastMsg).toContain('Hello World!')

    setLogCallback(() => {})
  })

  test('falls back to key for missing messages', () => {
    let lastMsg = ''
    const logger = new Logger('test')
    setLogCallback(entry => {
      lastMsg = entry.msg
    })

    const msgs: Record<string, string> = {}
    const ml = messageLogger(logger, msgs) as any
    ml.MISSING_MSG()
    expect(lastMsg).toContain('MISSING_MSG')

    setLogCallback(() => {})
  })
})
