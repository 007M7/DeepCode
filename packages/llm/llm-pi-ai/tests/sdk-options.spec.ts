import { afterEach, describe, expect, it, vi } from 'vitest'

const streamSimple = vi.hoisted(() => vi.fn())

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>()
  return { ...actual, streamSimple }
})

import { PiAiAdapter } from '../src/adapter.ts'

afterEach(() => { streamSimple.mockReset() })

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    const failure = new Error('mock SDK boundary')
    streamSimple.mockReturnValue({
      async * [Symbol.asyncIterator](): AsyncGenerator<never> {
        throw failure
      },
    })
    const adapter = new PiAiAdapter({ profiles: [{ provider: 'openai', apiKey: 'test-key' }] })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'openai',
        model: 'gpt-4.1',
        messages: [],
      })) { /* drain */ }
    }

    await expect(drain()).rejects.toBe(failure)
    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0 })
  })
})
