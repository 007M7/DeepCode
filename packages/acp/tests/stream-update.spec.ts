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

describe('terminal-card mapping (capability-gated)', () => {
  // A tool that asks to render as a terminal — a stand-in for tool-bash's shape,
  // letting us drive the bridge's terminal mapping without the real executor.
  type CallTerm = { cwd?: string } | undefined
  type ResultTerm = { output?: string; exitCode?: number; signal?: string } | undefined
  const termTool = (callTerminal: CallTerm, resultTerminal: ResultTerm): ToolDefinition => ({
    name: 'bash',
    description: 'run a command',
    parameters: {},
    execute: async () => [],
    presentCall: (args: unknown) => ({
      title: (args as { command: string }).command,
      kind: 'execute',
      rawInput: (args as { command: string }).command,
      content: [{ type: 'text', text: (args as { description: string }).description }],
      ...callTerminal !== undefined ? { terminal: callTerminal } : {},
    }),
    presentResult: () => ({
      content: [{ type: 'text', text: 'fallback' }],
      ...resultTerminal !== undefined ? { terminal: resultTerminal } : {},
    }),
  })

  const callEvent = evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'echo hi', description: 'Greet' }) })
  const resultEvent = evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'hi\n' }], isError: false })

  function termUpdates(tool: ToolDefinition, enabled: boolean, cwd: string | undefined, ...events: SessionEvent[]): SessionNotification['update'][] {
    const presenter = new ToolPresenter(registryOf(tool))
    const out: SessionNotification['update'][] = []
    for (const event of events) streamSessionEventUpdate('s1', event, n => out.push(n.update), presenter, { enabled, cwd })
    return out
  }

  it('capability ON: description content THEN terminal block; cwd from the session header when the tool gives none', () => {
    const [call, update] = termUpdates(termTool({}, { output: 'hi\n', exitCode: 0 }), true, '/work/proj', callEvent, resultEvent)
    expect(call).toMatchObject({
      sessionUpdate: 'tool_call',
      content: [
        { type: 'content', content: { type: 'text', text: 'Greet' } },
        { type: 'terminal', terminalId: 'c1' },
      ],
      _meta: { terminal_info: { terminal_id: 'c1', cwd: '/work/proj' } },
    })
    // The update OMITS content (it would clobber the terminal block) and carries output + exit.
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      _meta: { terminal_output: { terminal_id: 'c1', data: 'hi\n' }, terminal_exit: { terminal_id: 'c1', exit_code: 0 } },
    })
  })

  it('capability ON: an ABSOLUTE tool cwd wins; a RELATIVE one resolves against the session cwd', () => {
    const [absCall] = termUpdates(termTool({ cwd: '/explicit/abs' }, { output: 'x' }), true, '/work/proj', callEvent)
    expect((absCall as unknown as { _meta: { terminal_info: { cwd: string } } })._meta.terminal_info.cwd).toBe('/explicit/abs')
    const [relCall] = termUpdates(termTool({ cwd: 'sub/dir' }, { output: 'x' }), true, '/work/proj', callEvent)
    // Relative workdir resolved against the session cwd — the card header matches
    // where execution actually ran (tool-bash resolves the same way).
    expect((relCall as unknown as { _meta: { terminal_info: { cwd: string } } })._meta.terminal_info.cwd).toBe('/work/proj/sub/dir')
    // No session cwd to resolve against → the relative tool cwd is passed through as-is.
    const [noSessionCwd] = termUpdates(termTool({ cwd: 'rel/only' }, { output: 'x' }), true, undefined, callEvent)
    expect((noSessionCwd as unknown as { _meta: { terminal_info: { cwd: string } } })._meta.terminal_info.cwd).toBe('rel/only')
  })

  it('capability ON: a signal kill maps to terminal_exit.signal', () => {
    const [, update] = termUpdates(termTool({}, { output: 'gone', signal: 'SIGKILL' }), true, '/w', callEvent, resultEvent)
    expect((update as unknown as { _meta: { terminal_exit: unknown } })._meta.terminal_exit).toEqual({ terminal_id: 'c1', signal: 'SIGKILL' })
  })

  it('capability ON: a terminal result with output but NO exit/signal emits terminal_output and NO exit pill', () => {
    // A terminal-rendering tool that reports no structured exit (neither exitCode
    // nor signal) — the card shows output but no exit pill.
    const [, update] = termUpdates(termTool({}, { output: 'partial' }), true, '/w', callEvent, resultEvent)
    const meta = (update as unknown as { _meta: { terminal_output?: unknown; terminal_exit?: unknown } })._meta
    expect(meta.terminal_output).toEqual({ terminal_id: 'c1', data: 'partial' })
    expect(meta.terminal_exit).toBeUndefined()
  })

  it('capability OFF: no terminal block or _meta; the description content and fenced result still render', () => {
    const [call, update] = termUpdates(termTool({}, { output: 'hi\n' }), false, '/work/proj', callEvent, resultEvent)
    expect(call).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'echo hi',
      kind: 'execute',
      status: 'in_progress',
      rawInput: 'echo hi',
      content: [{ type: 'content', content: { type: 'text', text: 'Greet' } }],
    })
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'fallback' } }],
    })
  })

  it('orphan guard: a result-side terminal with NO call-side terminal is dropped (no orphan terminal_output)', () => {
    // presentCall declares NO terminal, but presentResult returns one — the
    // bridge must not emit _meta.terminal_output for a terminal Zed never made.
    const [call, update] = termUpdates(termTool(undefined, { output: 'hi\n', exitCode: 0 }), true, '/w', callEvent, resultEvent)
    // The call had no terminal → ordinary tool_call (description content, no _meta).
    expect((call as { _meta?: unknown })._meta).toBeUndefined()
    expect((call as { content: unknown }).content).toEqual([{ type: 'content', content: { type: 'text', text: 'Greet' } }])
    // The result falls back to text content; NO terminal _meta.
    expect((update as { _meta?: unknown })._meta).toBeUndefined()
    expect((update as { content: unknown }).content).toEqual([{ type: 'content', content: { type: 'text', text: 'fallback' } }])
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
