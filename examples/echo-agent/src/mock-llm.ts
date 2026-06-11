import type { Context } from 'cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Demo adapter for the `mock-echo` model.
 *
 * Behavior: if the last user text starts with "echo ", it calls the `echo`
 * tool with the rest of the line (exercising the tool round-trip), otherwise
 * it streams a canned reply quoting the input.
 */
class MockEchoAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const lastUserText = [...options.messages].reverse()
      .filter(message => message.role === 'user')
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .find(text => !text.startsWith('<')) ?? ''

    const hasToolResult = options.messages.at(-1)?.content.some(block => block.type === 'tool-result')

    if (lastUserText.startsWith('echo ') && !hasToolResult) {
      const payload = lastUserText.slice(5)
      const args = JSON.stringify({ text: payload })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const char of 'Let me echo that for you.') {
        yield { type: 'text-delta', index: 0, text: char }
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Let me echo that for you.' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: 'call-echo', name: 'echo', argumentsDelta: args }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-echo', name: 'echo', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const reply = hasToolResult
      ? 'The echo tool has spoken.'
      : `You said: "${lastUserText}". Try "echo <something>" to see a tool call.`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const char of reply) {
      yield { type: 'text-delta', index: 0, text: char }
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: reply.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'mock-llm'
export const inject = ['llm']

export function apply(ctx: Context) {
  ctx.llm.registerAdapter(['mock-echo'], new MockEchoAdapter())
}
