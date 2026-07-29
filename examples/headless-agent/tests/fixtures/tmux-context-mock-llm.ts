import type { Context } from 'cordis'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Deterministic one-step adapter for the tmux-context Loader fixture. */
class TmuxContextMockAdapter extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    const text = 'tmux context sampled'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'tmux-context-mock-llm'
export const inject = ['llm']

/** Register the test-only `tmux-context-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['tmux-context-mock'], new TmuxContextMockAdapter())
}
