import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import type { StdioRuntime } from '../src/index.ts'

const createInterface = vi.hoisted(() => vi.fn(() => {
  const reader = new EventEmitter() as EventEmitter & { close(): void }
  reader.close = vi.fn()
  return reader
}))

vi.mock('node:readline', () => ({ createInterface }))

function fakeContext(): Context {
  return {
    on: vi.fn(() => vi.fn()),
    effect: vi.fn((callback: () => () => void) => callback()),
    // The UI seeds its root target from the registry at install; this suite only
    // exercises readline terminal-mode selection, so an empty roster suffices.
    agents: { roots: vi.fn(() => []) },
    userInteraction: { registerProvider: vi.fn(() => vi.fn()) },
  } as unknown as Context
}

function fakeRuntime(inputIsTTY: boolean, outputIsTTY: boolean): StdioRuntime {
  return {
    input: { isTTY: inputIsTTY } as Readable & { isTTY: boolean },
    output: { isTTY: outputIsTTY, write: vi.fn(() => true) } as unknown as Writable & { isTTY: boolean },
    exit: vi.fn(),
  }
}

describe('createStdioChat readline mode', () => {
  it('enables terminal editing only when both stdio streams are TTYs', async () => {
    const { createStdioChat } = await import('../src/index.ts')

    const tty = fakeRuntime(true, true)
    createStdioChat(fakeContext(), {}, tty)
    expect(createInterface).toHaveBeenLastCalledWith({
      input: tty.input,
      output: tty.output,
      terminal: true,
    })

    const piped = fakeRuntime(true, false)
    createStdioChat(fakeContext(), {}, piped)
    expect(createInterface).toHaveBeenLastCalledWith({
      input: piped.input,
      output: piped.output,
      terminal: false,
    })
  })
})
