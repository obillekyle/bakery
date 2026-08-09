import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { PromptTracker } from './prompt-tracker'

describe('PromptTracker', () => {
  const testPid = 999999

  test('getFilePath returns expected path', () => {
    const path = PromptTracker.getFilePath(testPid)
    expect(path).toContain(String(testPid))
    expect(path).toContain('.prompt-active-')
  })

  test('activate creates file', async () => {
    PromptTracker.activate(testPid)

    await new Promise(r => setTimeout(r, 50))
    const path = PromptTracker.getFilePath(testPid)
    expect(existsSync(path)).toBe(true)
  })

  test('isActive returns true when file exists', async () => {
    const active = await PromptTracker.isActive(testPid)
    expect(active).toBe(true)
  })

  test('deactivate removes file', () => {
    PromptTracker.deactivate(testPid)
    const path = PromptTracker.getFilePath(testPid)
    expect(existsSync(path)).toBe(false)
  })

  test('isActive returns false when file does not exist', async () => {
    const active = await PromptTracker.isActive(testPid)
    expect(active).toBe(false)
  })

  test('deactivate on non-existent file does not throw', () => {
    expect(() => PromptTracker.deactivate(1234567)).not.toThrow()
  })
})
