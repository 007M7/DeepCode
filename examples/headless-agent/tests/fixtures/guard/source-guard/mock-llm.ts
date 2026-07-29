import { resolve } from 'node:path'
import type { Context } from 'cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** The staged file the smoke builds in the process cwd; the guard must refuse to write it. */
const TARGET = resolve('staging/guarded.ts')

/**
 * Two-step adapter for the source-guard Loader fixture: the first step calls
 * `write` on the staged file, the second closes the turn once a tool result has
 * come back, so the transcript records what the model received.
 */
class SourceGuardMockAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const alreadyCalled = options.messages.some(message => message.content.some(
      block => block.type === 'tool-result',
    ))
    if (alreadyCalled) {
      const text = 'denied as expected'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const callId = CallId('source-guard-write')
    const args = JSON.stringify({ file_path: TARGET, content: 'edited\n' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: callId, name: 'write', argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'write', arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'source-guard-mock-llm'
export const inject = ['llm']

/** Register the test-only `source-guard-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['source-guard-mock'], new SourceGuardMockAdapter())
}
