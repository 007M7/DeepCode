import { afterEach, describe, expect, it, vi } from 'vitest'

const streamSimple = vi.hoisted(() => vi.fn())

// The 0.81 SDK moved `streamSimple` to the compat entry; the adapter imports it
// from there, so the mock must target the same specifier.
vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/compat')>()
  return { ...actual, streamSimple }
})

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'

afterEach(() => { streamSimple.mockReset() })

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    const failure = new Error('mock SDK boundary')
    streamSimple.mockReturnValue({
      async * [Symbol.asyncIterator](): AsyncGenerator<never> {
        throw failure
      },
    })
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ openai: { apiKey: 'test-key' } }),
      resolveApiKey: () => Promise.resolve('test-key'),
    })
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
