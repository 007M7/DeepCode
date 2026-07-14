import { describe, expect, it } from 'vitest'
import { renderContentBlocks, renderTranscript } from '@deepseek-ai/dsh-compact'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'

function session(): Session {
  return new Session(SessionId('render-spec'))
}

describe('renderContentBlocks', () => {
  it('renders text blocks verbatim and skips empty ones', () => {
    expect(renderContentBlocks([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '' },
      { type: 'text', text: 'world' },
    ])).toBe('hello\nworld')
  })

  it('wraps reasoning, skipping empty reasoning', () => {
    expect(renderContentBlocks([
      { type: 'reasoning', text: 'think' },
      { type: 'reasoning', text: '' },
    ])).toBe('[reasoning: think]')
  })

  it('renders tool-call as a name(args) placeholder', () => {
    expect(renderContentBlocks([
      { type: 'tool-call', id: CallId('c1'), name: 'read', arguments: '{"filePath":"a"}' },
    ])).toBe('[tool-call: read({"filePath":"a"})]')
  })

  it('renders tool-result with nested content, and bare when empty', () => {
    expect(renderContentBlocks([
      { type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }] },
      { type: 'tool-result', toolCallId: CallId('c2'), content: [] },
    ])).toBe('[tool-result: ok]\n[tool-result]')
  })

  it('renders an unknown (merge-extended) block type as a bare type tag', () => {
    const unknown = { type: 'image', data: 'zzz' } as unknown as ContentBlock
    expect(renderContentBlocks([unknown])).toBe('[image]')
  })

  it('returns the empty string for no blocks', () => {
    expect(renderContentBlocks([])).toBe('')
  })
})

describe('renderTranscript', () => {
  it('renders each surface event type with its label, in the seq order given', () => {
    const s = session()
    const user = s.append('user/message', {
      content: [{ type: 'text', text: 'fix the bug' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const assistant = s.append('assistant/message', { provenance: { provider: 'mock', model: 'mock' },
      turn: 0, step: 0,
      content: [{ type: 'text', text: 'looking' }],
    }, { surfaceOp: 'append' })
    const result = s.append('tool/result', {
      turn: 0, step: 0, callId: CallId('c1'),
      content: [{ type: 'text', text: 'exit 0' }],
      isError: false,
    }, { surfaceOp: 'append' })
    const context = s.append('context/message', {
      content: [{ type: 'text', text: 'file changed' }],
      source: { kind: 'plugin', plugin: 'fs' },
    }, { surfaceOp: 'append' })
    const steering = s.append('steering/message', {
      turn: 0,
      content: [{ type: 'text', text: 'stop that' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    expect(renderTranscript(s.events, [user.seq, assistant.seq, result.seq, context.seq, steering.seq])).toBe([
      'User: fix the bug',
      'Assistant: looking',
      'Tool result (call c1): exit 0',
      '[Context: file changed]',
      '[Steering: stop that]',
    ].join('\n\n'))
  })

  it('labels an error tool result "Tool error"', () => {
    const s = session()
    const result = s.append('tool/result', {
      turn: 0, step: 0, callId: CallId('c9'),
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    }, { surfaceOp: 'append' })
    expect(renderTranscript(s.events, [result.seq])).toBe('Tool error (call c9): boom')
  })

  it('renders NON-log-order seqs in the order given (surface order after a replace)', () => {
    const s = session()
    const first = s.append('user/message', {
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const second = s.append('user/message', {
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    expect(renderTranscript(s.events, [second.seq, first.seq])).toBe('User: second\n\nUser: first')
  })

  it('skips events that render to nothing, non-message events, and seqs with no event', () => {
    const s = session()
    const empty = s.append('user/message', {
      content: [{ type: 'text', text: '' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const emptyAssistant = s.append('assistant/message', { provenance: { provider: 'mock', model: 'mock' },
      turn: 0, step: 0,
      content: [{ type: 'text', text: '' }],
    }, { surfaceOp: 'append' })
    const emptyResult = s.append('tool/result', {
      turn: 0, step: 0, callId: CallId('c3'),
      content: [{ type: 'text', text: '' }],
      isError: false,
    }, { surfaceOp: 'append' })
    const emptyContext = s.append('context/message', {
      content: [{ type: 'text', text: '' }],
      source: { kind: 'plugin', plugin: 'fs' },
    }, { surfaceOp: 'append' })
    const emptySteering = s.append('steering/message', {
      turn: 0,
      content: [{ type: 'text', text: '' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    // A log-only (non-surface) event type: contributes nothing to a transcript.
    const lock = s.append('compact/start', { turn: 0 })
    expect(renderTranscript(s.events, [
      empty.seq, emptyAssistant.seq, emptyResult.seq, emptyContext.seq, emptySteering.seq, lock.seq, 9999,
    ])).toBe('')
  })
})
