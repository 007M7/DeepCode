import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { ToolDefinition, ToolRegistry as ToolRegistryType } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { streamSessionEventUpdate, agentOptions, todosToPlan, ToolPresenter } from '../src/index.ts'

/** Collect the updates a single event produces (no presenter → generic fallback). */
function updatesFor(event: SessionEvent): SessionNotification['update'][] {
  const out: SessionNotification['update'][] = []
  streamSessionEventUpdate(SessionId('s1'), event, n => out.push(n.update))
  return out
}

/** Collect the updates emitted by the live prompt stream (user echo suppressed). */
function liveUpdatesFor(event: SessionEvent): SessionNotification['update'][] {
  const out: SessionNotification['update'][] = []
  streamSessionEventUpdate(SessionId('s1'), event, n => out.push(n.update), undefined, undefined, { includeUserMessages: false })
  return out
}

/** A tiny tool registry stub exposing just `get` for {@link ToolPresenter}. */
function registryOf(...tools: ToolDefinition[]): Pick<ToolRegistryType, 'get'> {
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
      content: [{ type: 'reasoning', text: 'private' }],
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

  it('can suppress user/message chunks for live prompt turns', () => {
    expect(liveUpdatesFor(evt('user/message', {
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }))).toEqual([])
  })

  it('produces no update for boundary/other event types', () => {
    expect(updatesFor(evt('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } }))).toEqual([])
    expect(updatesFor(evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))).toEqual([])
    expect(updatesFor(evt('step/start', { turn: 1, step: 1 }))).toEqual([])
  })

  it('maps todo/write to a plan sessionUpdate with priority synthesized as medium', () => {
    expect(updatesFor(evt('todo/write', {
      todos: [
        { content: 'plan the work', status: 'in_progress' },
        { content: 'write the code', status: 'pending' },
        { content: 'run the tests', status: 'completed' },
      ],
    }))).toEqual([{
      sessionUpdate: 'plan',
      entries: [
        { content: 'plan the work', priority: 'medium', status: 'in_progress' },
        { content: 'write the code', priority: 'medium', status: 'pending' },
        { content: 'run the tests', priority: 'medium', status: 'completed' },
      ],
    }])
  })

  it('maps an empty todo list to a plan with no entries', () => {
    expect(updatesFor(evt('todo/write', { todos: [] }))).toEqual([{ sessionUpdate: 'plan', entries: [] }])
  })
})

describe('todosToPlan', () => {
  it('maps status 1:1 and stamps every entry priority medium', () => {
    expect(todosToPlan([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' },
    ])).toEqual({
      entries: [
        { content: 'a', priority: 'medium', status: 'pending' },
        { content: 'b', priority: 'medium', status: 'in_progress' },
        { content: 'c', priority: 'medium', status: 'completed' },
      ],
    })
  })
})

describe('ToolPresenter (tool-owned presentation via the tool registry)', () => {
  /** A tool whose presentCall/presentResult return generic-card views. */
  const bashLike: ToolDefinition = {
    name: 'bash',
    description: 'run a command',
    parameters: {},
    execute: async () => [],
    presentCall: (args: unknown) => {
      const a = args as { command: string; description: string }
      return { card: 'generic', title: a.description, kind: 'execute', rawInput: a.command }
    },
    presentResult: (_args: unknown, result: { content: { type: string }[] }) => ({
      card: 'generic',
      content: [{ type: 'text', text: `wrapped:${result.content.length}` }],
    }),
  }

  function updatesWith(presenter: ToolPresenter, ...events: SessionEvent[]): SessionNotification['update'][] {
    const out: SessionNotification['update'][] = []
    for (const event of events) streamSessionEventUpdate(SessionId('s1'), event, n => out.push(n.update), presenter)
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
      presentCall: () => ({ card: 'generic', title: 'Doing a thing' }),
      presentResult: () => ({ card: 'generic', title: 'Did the thing' }),
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
    // session/load replay (docs/defensive-patterns.md "contain callback exceptions at the
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

  it('an unknown render-intent card throws via the exhaustiveness guard (closed union)', () => {
    // The bridge switches on `view.card` and ends with assertNever: a rogue card
    // (only reachable by a cast — the union is closed) must throw, so adding a
    // real variant later fails to compile at the switch instead of silently
    // dropping the card.
    const rogue: ToolDefinition = {
      name: 'rogue',
      description: 'r',
      parameters: {},
      execute: async () => [],
      // A card value outside the union — forced with a cast (no valid input reaches this).
      presentCall: () => ({ card: 'chart', title: 'nope' }) as unknown as ReturnType<NonNullable<ToolDefinition['presentCall']>>,
    }
    const presenter = new ToolPresenter(registryOf(rogue))
    expect(() => updatesWith(presenter, evt('tool/call', {
      turn: 1, step: 1, callId: CallId('c1'), name: 'rogue', arguments: '{}',
    }))).toThrow('unreachable variant')
  })

  it('an unknown render-intent RESULT card throws via the exhaustiveness guard (closed union)', () => {
    // The result-side renderer is also an exhaustive switch + assertNever: a rogue
    // result card (only reachable by a cast) must throw, so adding a real result
    // variant later fails to compile at the switch.
    const rogue: ToolDefinition = {
      name: 'rogue',
      description: 'r',
      parameters: {},
      execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'r' }),
      presentResult: () => ({ card: 'chart' }) as unknown as ReturnType<NonNullable<ToolDefinition['presentResult']>>,
    }
    const presenter = new ToolPresenter(registryOf(rogue))
    expect(() => updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'rogue', arguments: '{}' }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'x' }], isError: false }),
    )).toThrow('unreachable variant')
  })

  it('forwards fs-tool render intents onto the wire (REAL read → generic locations, edit → diff content)', async () => {
    // Use the SHIPPING fs tools (not a stand-in), booted through their real
    // plugins, so the wire tool_call carries the actual presentCall output —
    // read's follow-along `locations` and edit's `diff` content block. (docs/testing.md
    // "prefer the real implementation over a mock".)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(FsLocal)
    await ctx.plugin(ToolFs)
    const presenter = new ToolPresenter(ctx.tools)

    const [readCall] = updatesWith(presenter, evt('tool/call', {
      turn: 1, step: 1, callId: CallId('r1'), name: 'read',
      arguments: JSON.stringify({ file_path: 'src/a.ts', offset: 12 }),
    }))
    // A generic card: the read window is in the title, the offset drives the
    // follow-along location line. No rawInput (the window lives in the title).
    expect(readCall).toMatchObject({
      sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read src/a.ts (from line 12)', kind: 'read',
      locations: [{ path: 'src/a.ts', line: 12 }],
    })
    expect((readCall as { rawInput?: unknown }).rawInput).toBeUndefined()

    const [editCall] = updatesWith(presenter, evt('tool/call', {
      turn: 1, step: 1, callId: CallId('e1'), name: 'edit',
      arguments: JSON.stringify({ file_path: 'src/b.ts', old_string: 'x', new_string: 'y' }),
    }))
    // A diff card: `edit` kind, a `{ type: 'diff' }` content block carrying the
    // literal old→new replacement, plus the follow-along location.
    expect(editCall).toMatchObject({
      sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Edit src/b.ts', kind: 'edit',
      locations: [{ path: 'src/b.ts' }],
      content: [{ type: 'diff', path: 'src/b.ts', oldText: 'x', newText: 'y' }],
    })
    await ctx.fiber.dispose()
  })
})

describe('terminal-card mapping (capability-gated)', () => {
  // A tool that renders as a terminal — a stand-in for tool-bash's shape, letting
  // us drive the bridge's terminal mapping without the real executor. `callCard`
  // selects a terminal call view (optionally with a cwd) or a generic one (for the
  // orphan-guard test); `resultTerminal` is the terminal result view's output/exit.
  type CallCard = { card: 'terminal'; cwd?: string } | { card: 'generic' }
  type ResultTerm = { title?: string; output?: string; exitCode?: number; signal?: string }
  const termTool = (callCard: CallCard, resultTerminal: ResultTerm): ToolDefinition => ({
    name: 'bash',
    description: 'run a command',
    parameters: {},
    execute: async () => [],
    presentCall: (args: unknown) => {
      const command = (args as { command: string }).command
      const description = (args as { description: string }).description
      if (callCard.card === 'terminal') {
        return { card: 'terminal', title: command, description, ...callCard.cwd !== undefined ? { cwd: callCard.cwd } : {} }
      }
      return { card: 'generic', title: command, kind: 'execute', rawInput: command, content: [{ type: 'text', text: description }] }
    },
    presentResult: () => ({ card: 'terminal', ...resultTerminal }),
  })

  const callEvent = evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'echo hi', description: 'Greet' }) })
  const resultEvent = evt('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'hi\n' }], isError: false })

  function termUpdates(tool: ToolDefinition, enabled: boolean, cwd: string | undefined, ...events: SessionEvent[]): SessionNotification['update'][] {
    const presenter = new ToolPresenter(registryOf(tool))
    const out: SessionNotification['update'][] = []
    for (const event of events) streamSessionEventUpdate(SessionId('s1'), event, n => out.push(n.update), presenter, { enabled, cwd })
    return out
  }

  it('capability ON: description content THEN terminal block; cwd from the session header when the tool gives none', () => {
    const [call, update] = termUpdates(termTool({ card: 'terminal' }, { output: 'hi\n', exitCode: 0 }), true, '/work/proj', callEvent, resultEvent)
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
    const [absCall] = termUpdates(termTool({ card: 'terminal', cwd: '/explicit/abs' }, { output: 'x' }), true, '/work/proj', callEvent)
    expect((absCall as unknown as { _meta: { terminal_info: { cwd: string } } })._meta.terminal_info.cwd).toBe('/explicit/abs')
    const [relCall] = termUpdates(termTool({ card: 'terminal', cwd: 'sub/dir' }, { output: 'x' }), true, '/work/proj', callEvent)
    // Relative workdir resolved against the session cwd — the card header matches
    // where execution actually ran (tool-bash resolves the same way).
    expect((relCall as unknown as { _meta: { terminal_info: { cwd: string } } })._meta.terminal_info.cwd).toBe('/work/proj/sub/dir')
    // No session cwd to resolve against → the relative tool cwd is passed through as-is.
    const [noSessionCwd] = termUpdates(termTool({ card: 'terminal', cwd: 'rel/only' }, { output: 'x' }), true, undefined, callEvent)
    expect((noSessionCwd as unknown as { _meta: { terminal_info: { cwd: string } } })._meta.terminal_info.cwd).toBe('rel/only')
  })

  it('capability ON: a signal kill maps to terminal_exit.signal', () => {
    const [, update] = termUpdates(termTool({ card: 'terminal' }, { output: 'gone', signal: 'SIGKILL' }), true, '/w', callEvent, resultEvent)
    expect((update as unknown as { _meta: { terminal_exit: unknown } })._meta.terminal_exit).toEqual({ terminal_id: 'c1', signal: 'SIGKILL' })
  })

  it('capability ON: a terminal result with output but NO exit/signal emits terminal_output and NO exit pill', () => {
    // A terminal-rendering tool that reports no structured exit (neither exitCode
    // nor signal) — the card shows output but no exit pill.
    const [, update] = termUpdates(termTool({ card: 'terminal' }, { output: 'partial' }), true, '/w', callEvent, resultEvent)
    const meta = (update as unknown as { _meta: { terminal_output?: unknown; terminal_exit?: unknown } })._meta
    expect(meta.terminal_output).toEqual({ terminal_id: 'c1', data: 'partial' })
    expect(meta.terminal_exit).toBeUndefined()
  })

  it('capability OFF: no terminal block or _meta; the description content and the bridge-derived fenced result render', () => {
    const [call, update] = termUpdates(termTool({ card: 'terminal' }, { output: 'hi\n' }), false, '/work/proj', callEvent, resultEvent)
    expect(call).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'echo hi',
      kind: 'execute',
      status: 'in_progress',
      rawInput: 'echo hi',
      content: [{ type: 'content', content: { type: 'text', text: 'Greet' } }],
    })
    // The bridge derives the fenced ```console fallback from the terminal output.
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '```console\nhi\n```' } }],
    })
  })

  it('orphan guard: a result-side terminal with a GENERIC call is dropped (no orphan terminal_output)', () => {
    // presentCall is a generic card, but presentResult returns a terminal view —
    // the bridge must not emit _meta.terminal_output for a terminal Zed never made.
    const [call, update] = termUpdates(termTool({ card: 'generic' }, { output: 'hi\n', exitCode: 0 }), true, '/w', callEvent, resultEvent)
    // The call was generic → ordinary tool_call (description content, no _meta).
    expect((call as { _meta?: unknown })._meta).toBeUndefined()
    expect((call as { content: unknown }).content).toEqual([{ type: 'content', content: { type: 'text', text: 'Greet' } }])
    // The result falls back to the RAW result content (the tool/result event's text); NO terminal _meta.
    expect((update as { _meta?: unknown })._meta).toBeUndefined()
    expect((update as { content: unknown }).content).toEqual([{ type: 'content', content: { type: 'text', text: 'hi\n' } }])
  })

  it('capability ON: a terminal result title replaces the completed-card title; missing output emits empty data', () => {
    // A terminal result MAY carry a replacement title and MAY omit output (a run
    // that produced nothing) — the _meta carries empty data, not a dropped key.
    const [, update] = termUpdates(termTool({ card: 'terminal' }, { title: 'Ran echo', exitCode: 0 }), true, '/w', callEvent, resultEvent)
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      title: 'Ran echo',
      _meta: { terminal_output: { terminal_id: 'c1', data: '' }, terminal_exit: { terminal_id: 'c1', exit_code: 0 } },
    })
  })

  it('capability OFF: a terminal result title rides on the fenced fallback update', () => {
    const [, update] = termUpdates(termTool({ card: 'terminal' }, { title: 'Ran echo', output: 'hi\n' }), false, '/w', callEvent, resultEvent)
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '```console\nhi\n```' } }],
      title: 'Ran echo',
    })
  })

  it('a terminal call with NO description and NO capability is a bare execute card (no content key)', () => {
    // A terminal view whose presentCall omits `description`, with the capability
    // OFF: no description block and no terminal block → the card carries no content.
    const noDesc: ToolDefinition = {
      name: 'bash',
      description: 'run a command',
      parameters: {},
      execute: async () => [],
      presentCall: (args: unknown) => ({ card: 'terminal', title: (args as { command: string }).command }),
    }
    const [call] = termUpdates(noDesc, false, undefined, callEvent)
    expect(call).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'echo hi',
      kind: 'execute',
      status: 'in_progress',
      rawInput: 'echo hi',
    })
  })
})

describe('diff-card mapping', () => {
  // A stand-in diff tool, letting us drive the bridge's diff arm across shapes
  // the shipping fs tools don't emit (no locations, empty diffs).
  const diffTool = (view: unknown): ToolDefinition => ({
    name: 'writer',
    description: 'writes a file',
    parameters: {},
    execute: async () => [],
    presentCall: () => view as ReturnType<NonNullable<ToolDefinition['presentCall']>>,
  })
  function callUpdate(tool: ToolDefinition, cwd: string | undefined): SessionNotification['update'] {
    const presenter = new ToolPresenter(registryOf(tool))
    const out: SessionNotification['update'][] = []
    streamSessionEventUpdate(
      SessionId('s1'),
      evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'writer', arguments: '{}' }),
      n => out.push(n.update),
      presenter,
      { enabled: false, cwd },
    )
    return out[0]!
  }

  it('a diff with NO locations relativizes the title off the first diff path; omits the locations key', () => {
    const update = callUpdate(diffTool({ card: 'diff', title: 'Write /work/proj/a.txt', diffs: [{ path: '/work/proj/a.txt', oldText: null, newText: 'x' }] }), '/work/proj')
    expect(update).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Write a.txt',
      kind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: '/work/proj/a.txt', oldText: null, newText: 'x' }],
    })
  })

  it('a diff with an EMPTY diffs array omits the content key (no diff blocks to send)', () => {
    const update = callUpdate(diffTool({ card: 'diff', title: 'Write nothing', diffs: [] }), undefined)
    expect(update).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Write nothing',
      kind: 'edit',
      status: 'in_progress',
    })
  })
})

describe('result-time diff card (REAL fs edit tool → tool_call_update diff blocks)', () => {
  // Drive the SHIPPING fs edit tool through the bridge: the pending tool/call
  // installs the call-time snippet, then the tool/result carries the tool's
  // computed applied-hunk `meta`, which presentResult narrows into a `diff`
  // result card the bridge forwards as `{ type: 'diff' }` content blocks. Uses
  // the REAL tool (not a stand-in) per the anti-mock convention, mirroring the
  // call-side diff test above.
  async function fsCtx(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(FsLocal)
    await ctx.plugin(ToolFs)
    return ctx
  }

  function updatesWith(presenter: ToolPresenter, ...events: SessionEvent[]): SessionNotification['update'][] {
    const out: SessionNotification['update'][] = []
    for (const event of events) streamSessionEventUpdate(SessionId('s1'), event, n => out.push(n.update), presenter)
    return out
  }

  it('forwards the applied-hunk meta onto the wire as tool_call_update diff content', async () => {
    const ctx = await fsCtx()
    const presenter = new ToolPresenter(ctx.tools)
    const args = JSON.stringify({ file_path: 'src/b.ts', old_string: 'OLD', new_string: 'NEW' })
    // The applied hunk the tool would compute and persist on the result meta.
    const meta = { diffs: [{ path: 'src/b.ts', oldText: 'a\nOLD\nb', newText: 'a\nNEW\nb' }] }
    const [, resultUpdate] = updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('e1'), name: 'edit', arguments: args }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('e1'), content: [{ type: 'text', text: 'ok' }], isError: false, meta }),
    )
    expect(resultUpdate).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      status: 'completed',
      title: 'Edit src/b.ts',
      content: [{ type: 'diff', path: 'src/b.ts', oldText: 'a\nOLD\nb', newText: 'a\nNEW\nb' }],
    })
    await ctx.fiber.dispose()
  })

  it('an error result carries NO diff card (falls back to raw content)', async () => {
    const ctx = await fsCtx()
    const presenter = new ToolPresenter(ctx.tools)
    const args = JSON.stringify({ file_path: 'src/b.ts', old_string: 'OLD', new_string: 'NEW' })
    const [, resultUpdate] = updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('e1'), name: 'edit', arguments: args }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('e1'), content: [{ type: 'text', text: 'Error: boom' }], isError: true }),
    )
    expect(resultUpdate).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'failed' })
    expect(resultUpdate).not.toHaveProperty('content', expect.arrayContaining([expect.objectContaining({ type: 'diff' })]))
    await ctx.fiber.dispose()
  })

  it('the completed diff TITLE relativizes against the session cwd (the result title replaces the card header)', async () => {
    // A `tool_call_update.title` replaces the card header, so the result-side
    // diff must relativize its title exactly as the pending card did — otherwise
    // a completed absolute-path edit flips `Edit src/b.ts` back to the raw
    // absolute path. The diff/location paths stay absolute (the editor opens the
    // real path). Drive the REAL fs edit tool with an absolute in-workspace path.
    const ctx = await fsCtx()
    const presenter = new ToolPresenter(ctx.tools)
    const args = JSON.stringify({ file_path: '/work/proj/src/b.ts', old_string: 'OLD', new_string: 'NEW' })
    const meta = { diffs: [{ path: '/work/proj/src/b.ts', oldText: 'a\nOLD\nb', newText: 'a\nNEW\nb' }] }
    const out: SessionNotification['update'][] = []
    const rendering = { enabled: false, cwd: '/work/proj' }
    for (const event of [
      evt('tool/call', { turn: 1, step: 1, callId: CallId('e1'), name: 'edit', arguments: args }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('e1'), content: [{ type: 'text', text: 'ok' }], isError: false, meta }),
    ]) streamSessionEventUpdate(SessionId('s1'), event, n => out.push(n.update), presenter, rendering)
    expect(out[1]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      status: 'completed',
      title: 'Edit src/b.ts',
      content: [{ type: 'diff', path: '/work/proj/src/b.ts', oldText: 'a\nOLD\nb', newText: 'a\nNEW\nb' }],
    })
    await ctx.fiber.dispose()
  })

  it('a diff result with an EMPTY diffs array and no title omits both keys (nothing to send)', () => {
    // A synthetic tool whose presentResult yields a `diff` card with no hunks and
    // no title — the shipping fs tools never emit this (edit always has a hunk;
    // write always falls back to a whole-file diff), so a stand-in is the only way
    // to exercise the empty-content AND absent-title branches of the result-side
    // diff arm.
    const emptyDiffTool: ToolDefinition = {
      name: 'writer',
      description: 'writes a file',
      parameters: {},
      execute: async () => [],
      presentCall: () => ({ card: 'diff', title: 'Write x', diffs: [{ path: 'x', oldText: null, newText: 'y' }] }),
      presentResult: () => ({ card: 'diff', diffs: [] }),
    }
    const presenter = new ToolPresenter(registryOf(emptyDiffTool))
    const [, resultUpdate] = updatesWith(
      presenter,
      evt('tool/call', { turn: 1, step: 1, callId: CallId('w1'), name: 'writer', arguments: '{}' }),
      evt('tool/result', { turn: 1, step: 1, callId: CallId('w1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    )
    expect(resultUpdate).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'w1',
      status: 'completed',
    })
    expect(resultUpdate).not.toHaveProperty('content')
    expect(resultUpdate).not.toHaveProperty('title')
  })
})

describe('relative-path display titles (bridge relativizes the title against the session cwd)', () => {
  // The bridge relativizes a file card's TITLE against the session workspace cwd
  // (mirroring the reference adapter's toDisplayPath), while leaving locations/
  // diff paths RAW. Drive it with the REAL fs tools so the title/locations come
  // from the shipping presentCall, and pass an ABSOLUTE file path (which a real
  // editor forwards). The presenter is pure/args-only; the cwd is known only here.
  async function fsCtx(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(FsLocal)
    await ctx.plugin(ToolFs)
    return ctx
  }
  function callUpdate(ctx: Context, sessionCwd: string | undefined, name: string, args: unknown): SessionNotification['update'] {
    const presenter = new ToolPresenter(ctx.tools)
    const out: SessionNotification['update'][] = []
    streamSessionEventUpdate(
      SessionId('s1'),
      evt('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name, arguments: JSON.stringify(args) }),
      n => out.push(n.update),
      presenter,
      { enabled: false, cwd: sessionCwd },
    )
    return out[0]!
  }

  it('read: an absolute path inside the workspace relativizes the TITLE; the location path stays absolute', async () => {
    const ctx = await fsCtx()
    const update = callUpdate(ctx, '/work/proj', 'read', { file_path: '/work/proj/src/a.ts', offset: 5 })
    expect(update).toMatchObject({
      title: 'Read src/a.ts (from line 5)',
      locations: [{ path: '/work/proj/src/a.ts', line: 5 }],
    })
    await ctx.fiber.dispose()
  })

  it('edit: the diff TITLE relativizes; the diff/location paths stay absolute (the editor opens the real path)', async () => {
    const ctx = await fsCtx()
    const update = callUpdate(ctx, '/work/proj', 'edit', { file_path: '/work/proj/src/b.ts', old_string: 'x', new_string: 'y' })
    expect(update).toMatchObject({
      title: 'Edit src/b.ts',
      locations: [{ path: '/work/proj/src/b.ts' }],
      content: [{ type: 'diff', path: '/work/proj/src/b.ts', oldText: 'x', newText: 'y' }],
    })
    await ctx.fiber.dispose()
  })

  it('a path OUTSIDE the workspace is left as-is (no `..` title)', async () => {
    const ctx = await fsCtx()
    const update = callUpdate(ctx, '/work/proj', 'read', { file_path: '/etc/passwd' })
    expect((update as { title: string }).title).toBe('Read /etc/passwd')
    await ctx.fiber.dispose()
  })

  it('an in-workspace file whose relative form starts with `..` chars (a sibling name) still relativizes', async () => {
    // `/work/proj/..cache/x` is INSIDE the workspace — its relative form
    // `..cache/x` begins with the chars `..` but is NOT a parent segment. The
    // guard tests for a `..` SEGMENT, so this relativizes (matching the reference
    // adapter, which accepts any target under `cwd + sep`).
    const ctx = await fsCtx()
    const update = callUpdate(ctx, '/work/proj', 'read', { file_path: '/work/proj/..cache/x.ts' })
    expect((update as { title: string }).title).toBe('Read ..cache/x.ts')
    await ctx.fiber.dispose()
  })

  it('no session cwd → the absolute title is left unchanged', async () => {
    const ctx = await fsCtx()
    const update = callUpdate(ctx, undefined, 'read', { file_path: '/work/proj/src/a.ts' })
    expect((update as { title: string }).title).toBe('Read /work/proj/src/a.ts')
    await ctx.fiber.dispose()
  })

  it('a relative path is passed through unchanged (already display-friendly)', async () => {
    const ctx = await fsCtx()
    const update = callUpdate(ctx, '/work/proj', 'read', { file_path: 'src/a.ts' })
    expect((update as { title: string }).title).toBe('Read src/a.ts')
    await ctx.fiber.dispose()
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
