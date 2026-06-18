import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { streamSessionEventUpdate, agentOptions } from '../src/index.ts'

/** Collect the updates a single event produces. */
function updatesFor(event: SessionEvent): SessionNotification['update'][] {
  const out: SessionNotification['update'][] = []
  streamSessionEventUpdate('s1', event, n => out.push(n.update))
  return out
}

function evt<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data']): SessionEvent {
  return { type, seq: 0, time: 0, data } as SessionEvent
}

describe('streamSessionEventUpdate', () => {
  it('maps assistant/chunk text-delta to agent_message_chunk', () => {
    expect(updatesFor(evt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } })))
      .toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }])
  })

  it('maps assistant/chunk reasoning-delta to agent_thought_chunk', () => {
    expect(updatesFor(evt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'mm' } })))
      .toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'mm' } }])
  })

  it('produces no update for a non-text/reasoning chunk (e.g. block-start)', () => {
    expect(updatesFor(evt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } })))
      .toEqual([])
  })

  it('maps tool/call to an in_progress tool_call with inferred kind and parsed rawInput', () => {
    const updates = updatesFor(evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}' }))
    expect(updates).toEqual([{
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    }])
  })

  it('infers tool kinds: read*/write*/edit*/other', () => {
    const kind = (name: string): unknown =>
      updatesFor(evt('tool/call', { turn: 1, step: 1, callId: CallId('c'), name, arguments: '' }))[0]
    expect((kind('read_file') as { kind: string }).kind).toBe('read')
    expect((kind('write') as { kind: string }).kind).toBe('edit')
    expect((kind('edit_file') as { kind: string }).kind).toBe('edit')
    expect((kind('frobnicate') as { kind: string }).kind).toBe('other')
  })

  it('falls back to the raw argument string when tool arguments are not JSON', () => {
    const update = updatesFor(evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: 'not json' }))[0]
    expect((update as { rawInput: unknown }).rawInput).toBe('not json')
  })

  it('maps tool/result to completed/failed tool_call_update with text content', () => {
    const ok = updatesFor(evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'out' }], isError: false }))
    expect(ok).toEqual([{
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'out' } }],
    }])
    const failed = updatesFor(evt('tool/result', { turn: 1, step: 1, callId: CallId('c2'), content: [], isError: true }))
    expect((failed[0] as { status: string }).status).toBe('failed')
  })

  it('drops non-text tool-result content (text-only)', () => {
    const update = updatesFor(evt('tool/result', {
      turn: 1, step: 1, callId: CallId('c1'),
      content: [{ type: 'image', url: 'https://x/y.png' }],
      isError: false,
    }))[0]
    expect((update as { content: unknown[] }).content).toEqual([])
  })

  it('maps user/message text blocks to user_message_chunk (load replays the user side)', () => {
    // A text block surfaces; a non-text block (here a tool-call) is skipped, so
    // only the text chunk is emitted.
    expect(updatesFor(evt('user/message', {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool-call', id: CallId('c'), name: 'bash', arguments: '{}' },
      ],
      source: { kind: 'user' },
    }))).toEqual([{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }])
    // A user/message with no text-bearing blocks produces no chunk.
    expect(updatesFor(evt('user/message', { content: [], source: { kind: 'user' } }))).toEqual([])
  })

  it('produces no update for boundary/other event types', () => {
    expect(updatesFor(evt('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } }))).toEqual([])
    expect(updatesFor(evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))).toEqual([])
    expect(updatesFor(evt('usage', { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } }))).toEqual([])
  })
})

describe('agentOptions', () => {
  it('includes only the fields present in config', () => {
    expect(agentOptions({})).toEqual({})
    expect(agentOptions({ model: 'm' })).toEqual({ model: 'm' })
    expect(agentOptions({ systemPrompt: 'sp' })).toEqual({ systemPrompt: 'sp' })
    expect(agentOptions({ model: 'm', systemPrompt: 'sp' })).toEqual({ model: 'm', systemPrompt: 'sp' })
  })
})
