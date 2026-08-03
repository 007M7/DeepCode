import { describe, expect, it, vi } from 'vitest'

describe('@deepseek-ai/dsh-subagent optional session-query peer', () => {
  it('loads ordinary subagent operations without evaluating the optional query package', async () => {
    vi.doMock('@deepseek-ai/dsh-session-query', () => {
      throw new Error('optional session-query runtime was loaded eagerly')
    })

    const subagent = await import('../src/index.ts')

    expect(subagent.SubagentService).toBeTypeOf('function')
  })
})
