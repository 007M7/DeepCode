import { EventEmitter } from 'node:events'
import type { Context } from 'cordis'
import { describe, expect, test, vi } from 'vitest'

const createInterface = vi.hoisted(() => vi.fn(() => {
  const reader = new EventEmitter() as EventEmitter & { close(): void }
  reader.close = vi.fn()
  return reader
}))

vi.mock('node:readline', () => ({ createInterface }))

function fakeContext(): Context {
  return {
    agents: { get: vi.fn() },
    on: vi.fn(() => vi.fn()),
    effect: vi.fn((callback: () => () => void) => callback()),
  } as unknown as Context
}

describe('echo-agent stdio chat', () => {
  test('creates a terminal readline interface so TTY editing keys work', async () => {
    const { apply } = await import('../src/stdio-chat.ts')

    apply(fakeContext())

    expect(createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY && process.stdout.isTTY,
    })
  })
})
