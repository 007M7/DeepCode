import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'
import { toPiAssistant } from '../src/replay.ts'

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

const attachments = {
  readImage: vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1) })),
} as unknown as AttachmentStore

function request(messages: GenerateOptions['messages']): GenerateOptions {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    system: 'system prompt',
    tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object' } }],
    messages,
  }
}

describe('pi-ai request context conversion', () => {
  it('omits absent and empty request-level optional fields', () => {
    const base = { provider: 'openai', model: 'gpt-4.1', messages: [] }
    expect(toPiContext(base)).toEqual({ messages: [] })
    expect(toPiContext({ ...base, tools: [] })).toEqual({ messages: [] })
  })

  it('converts complete text-only history and rejects nested images without storage', () => {
    const callId = CallId('call-1')
    expect(toPiContext(request([
      { role: 'system', content: [{ type: 'text', text: 'history system' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'after tool' },
          {
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: '' }],
          },
        ],
      },
    ]))).toMatchObject({
      systemPrompt: 'system prompt',
      tools: [{ name: 'lookup' }],
      messages: [
        { role: 'user', content: 'history system' },
        { role: 'assistant' },
        { role: 'user', content: 'after tool' },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'lookup',
          content: [{ type: 'text', text: '(no output)' }],
          isError: false,
        },
      ],
    })

    expect(() => toPiContext(request([{
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'image', attachment: ref }],
      }],
    }]))).toThrow(/durable attachment service/)
  })

  it('resolves user and tool-result images while preserving explicit fallbacks', async () => {
    const callId = CallId('missing-call')
    const knownCallId = CallId('known-call')
    const context = await toPiContext(request([
      { role: 'user', content: [{ type: 'text', text: '' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: knownCallId, name: 'lookup', arguments: '{}' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: 'caption' },
          { type: 'reasoning', text: 'ignored' },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: knownCallId,
          content: [{ type: 'text', text: '' }],
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: true,
          content: [
            { type: 'tool-result', toolCallId: callId, content: [] },
            { type: 'image', attachment: ref },
          ],
        }],
      },
    ]), attachments)

    expect(context.messages).toEqual([
      { role: 'user', content: '', timestamp: 0 },
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'user',
        content: [
          { type: 'image', data: 'AQ==', mimeType: 'image/png' },
          { type: 'text', text: 'caption' },
        ],
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'known-call',
        toolName: 'lookup',
        content: [{ type: 'text', text: '(no output)' }],
        isError: false,
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'missing-call',
        toolName: 'unknown',
        content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
        isError: true,
        timestamp: 0,
      },
    ])
  })

  it('keeps empty text-only users while separating result-only messages', () => {
    const callId = CallId('unknown-call')
    expect(toPiContext(request([
      { role: 'user', content: [] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'tool-call', id: CallId('other-call'), name: 'lookup', arguments: '{}' },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: 'result' }],
        }],
      },
    ]))).toMatchObject({
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant' },
        { role: 'toolResult', toolName: 'unknown' },
      ],
    })
  })

  it('handles in-history system and assistant messages explicitly on the image path', async () => {
    await expect(toPiContext(request([{
      role: 'system',
      content: [{ type: 'image', attachment: ref }],
    }]), attachments)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })

    await expect(toPiContext(request([
      { role: 'system', content: [{ type: 'text', text: 'history system' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'plain' }] },
    ]), attachments)).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'history system' },
        { role: 'assistant' },
        { role: 'user', content: 'plain' },
      ],
    })

    expect(() => toPiAssistant({
      role: 'assistant',
      content: [{ type: 'image', attachment: ref }],
    })).toThrow(/assistant image output/)
  })
})
