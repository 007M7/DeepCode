import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, AssistantMessageEvent, Usage } from '@earendil-works/pi-ai'
import { mapStopReason, mapUsage, toPiContext, toStreamChunks } from '@deepseek-ai/dsh-llm-pi-ai'

function usage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: usage(),
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

async function* feed(...events: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) yield event
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('toPiContext', () => {
  it('maps system prompt, user text, and tools', () => {
    const context = toPiContext({
      model: 'deepseek-v4-flash',
      system: 'be helpful',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'f', description: 'F', parameters: { type: 'object', properties: {} } }],
    })
    expect(context.systemPrompt).toBe('be helpful')
    expect(context.messages).toEqual([{ role: 'user', content: 'hi', timestamp: 0 }])
    expect(context.tools).toEqual([
      { name: 'f', description: 'F', parameters: { type: 'object', properties: {} } },
    ])
  })

  it('omits empty tools and absent system prompt', () => {
    const context = toPiContext({ model: 'm', messages: [], tools: [] })
    expect(context.systemPrompt).toBeUndefined()
    expect(context.tools).toBeUndefined()
  })

  it('maps assistant text/reasoning/tool-call blocks', () => {
    const context = toPiContext({
      model: 'm',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'hmm' },
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: CallId('c1'), name: 'f', arguments: '{"a":1}' },
        ],
      }],
    })
    const message = context.messages[0] as AssistantMessage
    expect(message.role).toBe('assistant')
    expect(message.stopReason).toBe('toolUse')
    expect(message.content).toEqual([
      // thinkingSignature names the replay field — DeepSeek's passback rule.
      { type: 'thinking', thinking: 'hmm', thinkingSignature: 'reasoning_content' },
      { type: 'text', text: 'calling' },
      { type: 'toolCall', id: 'c1', name: 'f', arguments: { a: 1 } },
    ])
  })

  it('marks tool-call-free assistant messages with stopReason stop', () => {
    const context = toPiContext({
      model: 'm',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    })
    expect((context.messages[0] as AssistantMessage).stopReason).toBe('stop')
  })

  it('parses malformed tool-call arguments to {}', () => {
    const context = toPiContext({
      model: 'm',
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c1'), name: 'f', arguments: '{broken' }],
      }],
    })
    const message = context.messages[0] as AssistantMessage
    expect(message.content[0]).toEqual({ type: 'toolCall', id: 'c1', name: 'f', arguments: {} })
  })

  it('parses non-object argument JSON (arrays, scalars) to {}', () => {
    const context = toPiContext({
      model: 'm',
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c1'), name: 'f', arguments: '[1,2]' }],
      }],
    })
    expect((context.messages[0] as AssistantMessage).content[0]).toMatchObject({ arguments: {} })
  })

  it('recovers toolName for tool results from the preceding assistant call', () => {
    const context = toPiContext({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: CallId('c1'), name: 'get_weather', arguments: '{}' }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'Sunny' }] }],
        },
      ],
    })
    expect(context.messages[1]).toEqual({
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'get_weather',
      content: [{ type: 'text', text: 'Sunny' }],
      isError: false,
      timestamp: 0,
    })
  })

  it('labels unmatched tool results with toolName unknown and keeps isError', () => {
    const context = toPiContext({
      model: 'm',
      messages: [{
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('zz'), content: [], isError: true }],
      }],
    })
    expect(context.messages[0]).toMatchObject({
      role: 'toolResult',
      toolName: 'unknown',
      isError: true,
      content: [{ type: 'text', text: '(no output)' }],
    })
  })

  it('splits mixed user text + tool results and folds history system messages', () => {
    const context = toPiContext({
      model: 'm',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'rule' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'note' },
            { type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      ],
    })
    expect(context.messages.map(message => message.role)).toEqual(['user', 'user', 'toolResult'])
  })

  it('skips plugin-added (unknown) blocks in assistant content', () => {
    const context = toPiContext({
      model: 'm',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'chart', data: 'x' } as unknown as ContentBlock,
          { type: 'text', text: 'visible' },
        ],
      }],
    })
    expect((context.messages[0] as AssistantMessage).content).toEqual([{ type: 'text', text: 'visible' }])
  })
})

describe('toStreamChunks', () => {
  const partialWithToolCall = assistant({
    content: [{ type: 'toolCall', id: 'call-1', name: 'f', arguments: {} }],
  })

  it('maps text events to text blocks', async () => {
    const done = assistant({ content: [{ type: 'text', text: 'hi' }], usage: usage(3, 2) })
    const chunks = await collect(toStreamChunks(feed(
      { type: 'start', partial: assistant() },
      { type: 'text_start', contentIndex: 0, partial: assistant() },
      { type: 'text_delta', contentIndex: 0, delta: 'hi', partial: assistant() },
      { type: 'text_end', contentIndex: 0, content: 'hi', partial: assistant() },
      { type: 'done', reason: 'stop', message: done },
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps thinking events to reasoning blocks', async () => {
    const chunks = await collect(toStreamChunks(feed(
      { type: 'thinking_start', contentIndex: 0, partial: assistant() },
      { type: 'thinking_delta', contentIndex: 0, delta: 'mull', partial: assistant() },
      { type: 'thinking_end', contentIndex: 0, content: 'mull', partial: assistant() },
      { type: 'done', reason: 'stop', message: assistant() },
    )))
    expect(chunks.slice(0, 3)).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'mull' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'mull' } },
    ])
  })

  it('maps tool-call events, re-stringifying parsed arguments', async () => {
    const chunks = await collect(toStreamChunks(feed(
      { type: 'toolcall_start', contentIndex: 0, partial: partialWithToolCall },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"a"', partial: partialWithToolCall },
      { type: 'toolcall_delta', contentIndex: 0, delta: ':1}', partial: partialWithToolCall },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call-1', name: 'f', arguments: { a: 1 } },
        partial: partialWithToolCall,
      },
      { type: 'done', reason: 'toolUse', message: assistant({ stopReason: 'toolUse' }) },
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'f', argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'f', argumentsDelta: ':1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'f', arguments: '{"a":1}' } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('tolerates toolcall_start with a missing partial entry', async () => {
    const chunks = await collect(toStreamChunks(feed(
      { type: 'toolcall_start', contentIndex: 0, partial: assistant() },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: assistant() },
      { type: 'done', reason: 'stop', message: assistant() },
    )))
    expect(chunks[1]).toEqual({ type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{}' })
  })

  it('maps error events to error finish chunks (in-stream error style)', async () => {
    const error = assistant({ stopReason: 'error', errorMessage: 'boom', usage: usage(1, 0) })
    const chunks = await collect(toStreamChunks(feed(
      { type: 'error', reason: 'error', error },
    )))
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', message: 'boom', code: 'PI_AI_ERROR' } },
    ])
  })

  it('maps aborted error events to aborted finish', async () => {
    const error = assistant({ stopReason: 'aborted' })
    const chunks = await collect(toStreamChunks(feed({ type: 'error', reason: 'aborted', error })))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('rejects a stream that ends without done or error', async () => {
    await expect(collect(toStreamChunks(feed({ type: 'start', partial: assistant() }))))
      .rejects.toThrow(/without done\/error/)
  })
})

describe('mapStopReason / mapUsage', () => {
  it.each([
    ['stop', { kind: 'stop' }],
    ['length', { kind: 'max-tokens' }],
    ['toolUse', { kind: 'tool-calls' }],
    ['aborted', { kind: 'aborted' }],
  ] as const)('maps %s', (stopReason, expected) => {
    expect(mapStopReason(assistant({ stopReason }))).toEqual(expected)
  })

  it('defaults the error message when pi-ai omits it', () => {
    expect(mapStopReason(assistant({ stopReason: 'error' })))
      .toEqual({ kind: 'error', message: 'pi-ai stream error', code: 'PI_AI_ERROR' })
  })

  it('maps routable HTTP-ish error messages to stable codes', () => {
    expect(mapStopReason(assistant({ stopReason: 'error', errorMessage: 'HTTP 401: bad key' })))
      .toMatchObject({ kind: 'error', code: 'AUTH' })
    expect(mapStopReason(assistant({ stopReason: 'error', errorMessage: 'HTTP 429: rate limit' })))
      .toMatchObject({ kind: 'error', code: 'RATE_LIMIT' })
    expect(mapStopReason(assistant({ stopReason: 'error', errorMessage: 'HTTP 500: backend down' })))
      .toMatchObject({ kind: 'error', code: 'SERVER' })
  })

  it('maps cache fields only when nonzero', () => {
    expect(mapUsage(usage(10, 5, 8, 2))).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
    })
    expect(mapUsage(usage(10, 5))).toEqual({ inputTokens: 10, outputTokens: 5 })
  })
})

describe('toStreamChunks edge branches', () => {
  it('omits the name field for tool calls whose partial carried an empty name', async () => {
    const blank = assistant({ content: [{ type: 'toolCall', id: 'x', name: '', arguments: {} }] })
    const chunks = await collect(toStreamChunks(feed(
      { type: 'toolcall_start', contentIndex: 0, partial: blank },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: blank },
      { type: 'done', reason: 'stop', message: assistant() },
    )))
    expect(chunks[1]).toEqual({ type: 'tool-call-delta', index: 0, id: 'x', argumentsDelta: '{}' })
  })
})

describe('toStreamChunks defensive branches', () => {
  it('tolerates a toolcall_delta with no preceding toolcall_start', async () => {
    const chunks = await collect(toStreamChunks(feed(
      { type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: assistant() },
      { type: 'done', reason: 'stop', message: assistant() },
    )))
    expect(chunks[0]).toEqual({ type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{}' })
  })
})
