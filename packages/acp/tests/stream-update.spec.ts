import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { ToolDefinition, ToolRegistry } from '@deepseek-ai/dsh-tools'
import { streamSessionEventUpdate, agentOptions, ToolPresenter } from '../src/index.ts'

/** Collect the updates a single event produces (no presenter → generic fallback). */
function updatesFor(event: SessionEvent): SessionNotification['update'][] {
  const out: SessionNotification['update'][] = []
  streamSessionEventUpdate('s1', event, n => out.push(n.update))
  return out
}

/** A tiny tool registry stub exposing just `get` for {@link ToolPresenter}. */
function registryOf(...tools: ToolDefinition[]): Pick<ToolRegistry, 'get'> {
  const map = new Map(tools.map(t => [t.name, t]))
  return { get: name => map.get(name) }
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

  it('maps tool/call to an in_progress tool_call with inferred kind and parsed rawInput (generic fallback, no presenter)', () => {
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

describe('ToolPresenter (tool-owned presentation via the tool registry)', () => {
  /** A tool whose presentCall/presentResult mirror what tool-bash declares. */
  const bashLike: ToolDefinition = {
    name: 'bash',
    description: 'run a command',
    parameters: {},
    execute: async () => [],
    presentCall: (args: unknown) => {
      const a = args as { command: string; description: string }
      return { title: a.description, kind: 'execute', rawInput: a.command }
    },
    presentResult: (_args: unknown, result: { content: { type: string }[] }) => ({
      content: [{ type: 'text', text: `wrapped:${result.content.length}` }],
    }),
  }

  function updatesWith(presenter: ToolPresenter, ...events: SessionEvent[]): SessionNotification['update'][] {
    const out: SessionNotification['update'][] = []
    for (const event of events) streamSessionEventUpdate('s1', event, n => out.push(n.update), presenter)
    return out
  }

  it('tool/call uses the tool: description→title, command→rawInput, tool kind', () => {
    const presenter = new ToolPresenter(registryOf(bashLike))
    const [update] = updatesWith(presenter, evt('tool/call', {
      turn: 1, step: 1, callId: CallId('c1'), name: 'bash',
      arguments: JSON.stringify({ command: 'ls -la', description: 'List files' }),
    }))
    expect(update).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'List files',
      kind: 'execute',
      status: 'in_progress',
      rawInput: 'ls -la',
    })
  })

  it('tool/result uses the tool to reformat content (resolved by the remembered tool/call)', () => {
    const presenter = new ToolPresenter(registryOf(bashLike))
    const updates = updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'x', description: 'd' }) }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'out' }], isError: false }),
    )
    expect(updates[1]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'wrapped:1' } }],
    })
  })

  it('a result with NO preceding call (unknown callId) falls back to the raw content', () => {
    const presenter = new ToolPresenter(registryOf(bashLike))
    // No tool/call for c9 → presenter has nothing remembered → generic fallback.
    const [update] = updatesWith(presenter, evt('tool/result', {
      turn: 1, step: 1, callId: CallId('c9'), content: [{ type: 'text', text: 'raw' }], isError: false,
    }))
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c9',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'raw' } }],
    })
  })

  it('a tool with no presentCall/presentResult gets the generic fallback (title = name)', () => {
    const plain: ToolDefinition = { name: 'plain', description: 'p', parameters: {}, execute: async () => [] }
    const presenter = new ToolPresenter(registryOf(plain))
    const [update] = updatesWith(presenter, evt('tool/call', {
      turn: 1, step: 1, callId: CallId('c1'), name: 'plain', arguments: '{"a":1}',
    }))
    expect(update).toMatchObject({ title: 'plain', kind: 'other', rawInput: { a: 1 } })
  })

  it('a presentation that omits kind/content/rawInput uses the defaults (kind other, raw result content kept)', () => {
    // A minimal tool-owned presentation: presentCall returns only a title (no
    // kind → defaults to `other`, no rawInput → omitted); presentResult returns
    // only a title (no content → the raw result content is kept).
    const minimal: ToolDefinition = {
      name: 'mini',
      description: 'm',
      parameters: {},
      execute: async () => [],
      presentCall: () => ({ title: 'Doing a thing' }),
      presentResult: () => ({ title: 'Did the thing' }),
    }
    const presenter = new ToolPresenter(registryOf(minimal))
    const updates = updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'mini', arguments: '{}' }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'kept' }], isError: false }),
    )
    // No kind → 'other'; no rawInput key at all.
    expect(updates[0]).toEqual({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Doing a thing', kind: 'other', status: 'in_progress' })
    // Title replaced; content falls back to the raw result content.
    expect(updates[1]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'kept' } }],
      title: 'Did the thing',
    })
  })

  it('holds ONLY in-flight calls: the callId entry is removed once its result is presented', () => {
    const presenter = new ToolPresenter(registryOf(bashLike))
    updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'x', description: 'd' }) }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'o' }], isError: false }),
    )
    // A SECOND result for the same callId now finds nothing remembered, so it
    // falls back to raw content (proving the first result consumed the entry —
    // the map does not retain finished calls).
    const [late] = updatesWith(presenter, evt('tool/result', {
      turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'late' }], isError: false,
    }))
    expect(late).toMatchObject({ content: [{ type: 'content', content: { type: 'text', text: 'late' } }] })
  })

  it('a THROWING presentCall/presentResult is contained: generic fallback + onError, never propagates', () => {
    // A buggy tool whose display callbacks throw must NOT fail a live turn or a
    // session/load replay (AGENTS.md "contain callback exceptions at the
    // boundary"). The presenter swallows the throw, reports via onError, and
    // falls back to the generic presentation.
    const boom: ToolDefinition = {
      name: 'boom',
      description: 'b',
      parameters: {},
      execute: async () => [],
      presentCall: () => { throw new Error('call boom') },
      presentResult: () => { throw new Error('result boom') },
    }
    const errors: string[] = []
    const presenter = new ToolPresenter(registryOf(boom), msg => errors.push(msg))
    const updates = updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'boom', arguments: '{"a":1}' }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'raw' }], isError: false }),
    )
    // tool/call fell back to title=name, raw args as rawInput.
    expect(updates[0]).toMatchObject({ sessionUpdate: 'tool_call', title: 'boom', kind: 'other', rawInput: { a: 1 } })
    // tool/result fell back to the raw content.
    expect(updates[1]).toMatchObject({ sessionUpdate: 'tool_call_update', content: [{ type: 'content', content: { type: 'text', text: 'raw' } }] })
    // Both throws were reported, not propagated.
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('presentCall threw')
    expect(errors[1]).toContain('presentResult threw')
  })

  it('contains a throwing presenter even with the DEFAULT (no-op) onError sink', () => {
    // Constructed without an onError sink (the default `() => {}`): a throwing
    // presenter is still swallowed and falls back generically — the absence of a
    // logger must not turn a display bug into a propagated exception.
    const boom: ToolDefinition = {
      name: 'boom',
      description: 'b',
      parameters: {},
      execute: async () => [],
      presentCall: () => { throw new Error('call boom') },
      presentResult: () => { throw new Error('result boom') },
    }
    const presenter = new ToolPresenter(registryOf(boom))
    const updates = updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'boom', arguments: '{}' }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'raw' }], isError: false }),
    )
    expect(updates[0]).toMatchObject({ sessionUpdate: 'tool_call', title: 'boom' })
    expect(updates[1]).toMatchObject({ sessionUpdate: 'tool_call_update', content: [{ type: 'content', content: { type: 'text', text: 'raw' } }] })
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
