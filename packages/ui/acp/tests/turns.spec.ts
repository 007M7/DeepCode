import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import {
  errorResponse,
  makeBridgeHarness,
  maxTokensResponse,
  textResponse,
  toolCallResponse,
  type BridgeHarness,
} from './harness.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Boilerplate: initialize + create one session, returning its id. */
async function newSession(h: BridgeHarness, clientCapabilities: Record<string, unknown> = {}): Promise<string> {
  await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities })
  const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  return sessionId
}

describe('acp bridge — turn outcomes', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-test-')) })
  afterEach(async () => {
    if (harness) await harness.dispose()
    harness = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('maps a max-tokens turn to stopReason max_tokens', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [maxTokensResponse('cut off')] })
    const sessionId = await newSession(harness)
    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(res.stopReason).toBe('max_tokens')
  })

  it('rejects the prompt RPC when a turn fails (no misleading end_turn)', async () => {
    // ACP has no "error" stop reason; a failed turn must surface as a rejected
    // session/prompt, not a normal end_turn that hides the failure from the
    // client. The bridge rejects via the turn/end{error} log record.
    harness = await makeBridgeHarness({ storageDir, script: [errorResponse('provider boom')] })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: provider boom/)
  })

  it('rejects an ordinary plugin turn failure through the same ACP boundary', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('must not run')] })
    harness.ctx.on('agent/pre-step', () => { throw new Error('plugin pre-step failed') })
    const sessionId = await newSession(harness)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: plugin pre-step failed/)
  })

  it('streams a tool call as tool_call then tool_call_update', async () => {
    harness = await makeBridgeHarness({
      storageDir,
      script: [toolCallResponse('c1', 'bash', { command: 'echo hi' }), textResponse('done')],
    })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'run a command',
      parameters: { command: { type: 'string' } },
      async execute() { return [{ type: 'text', text: 'hi\n' }] },
    }))
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'run it' }] })

    const toolCalls = harness.updates.filter(u => u.sessionUpdate === 'tool_call')
    const toolUpdates = harness.updates.filter(u => u.sessionUpdate === 'tool_call_update')
    expect(toolCalls).toHaveLength(1)
    // The inline stand-in declares no presentCall, so the generic fallback
    // renders kind `other` (kinds are tool-owned; the bridge never sniffs the
    // name — the REAL dsh-tool-bash test below covers the execute card).
    expect(toolCalls[0]).toMatchObject({ toolCallId: 'c1', title: 'bash', kind: 'other', status: 'in_progress' })
    expect(toolUpdates).toHaveLength(1)
    expect(toolUpdates[0]).toMatchObject({ toolCallId: 'c1', status: 'completed' })

    // Ordering invariant: the tool_call precedes its tool_call_update.
    const callIdx = harness.updates.findIndex(u => u.sessionUpdate === 'tool_call')
    const updIdx = harness.updates.findIndex(u => u.sessionUpdate === 'tool_call_update')
    expect(callIdx).toBeLessThan(updIdx)
  })

  it('the REAL bash tool drives the tool-call UI end-to-end: command title + description block + console output', async () => {
    // Use the SHIPPING tool (dsh-tool-bash + dsh-bash-local), not an inline
    // stand-in, so this verifies the actual presentCall/presentResult the editor
    // sees (docs/testing.md "prefer the real implementation over a mock").
    // The mock MODEL still scripts the tool call (no real LLM needed), but the
    // tool and executor are real: a real `echo` runs and its real output flows
    // back through the bridge.
    harness = await makeBridgeHarness({
      storageDir,
      withBash: true,
      script: [
        toolCallResponse('c1', 'bash', { command: 'echo hello', description: 'Print a greeting' }),
        textResponse('done'),
      ],
    })
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'greet' }] })

    // presentCall: execute kind, title IS the command (an execute card hides
    // rawInput, so the command is the title), the description rides as a content
    // text block, the command is also rawInput for non-terminal UIs.
    const call = harness.updates.find(u => u.sessionUpdate === 'tool_call')
    expect(call).toMatchObject({
      toolCallId: 'c1',
      title: 'echo hello',
      kind: 'execute',
      rawInput: 'echo hello',
      status: 'in_progress',
    })
    if (call?.sessionUpdate !== 'tool_call') throw new Error('expected a tool_call')
    // Capability OFF: the description renders as the only content block (no terminal block).
    expect(call.content).toEqual([{ type: 'content', content: { type: 'text', text: 'Print a greeting' } }])
    // presentResult: the REAL command output, wrapped in a fenced console block.
    const update = harness.updates.find(u => u.sessionUpdate === 'tool_call_update')
    expect(update?.sessionUpdate).toBe('tool_call_update')
    if (update?.sessionUpdate !== 'tool_call_update') throw new Error('expected a tool_call_update')
    expect(update).toMatchObject({ toolCallId: 'c1', status: 'completed' })
    const content = update.content as { content: { type: string; text: string } }[]
    expect(content[0]?.content.text).toBe('```console\nhello\n```')
    // Capability OFF (the default newSession): NO terminal _meta on either update.
    expect((call as { _meta?: unknown })._meta).toBeUndefined()
    expect((update as { _meta?: unknown })._meta).toBeUndefined()
  })

  it('with the terminal_output capability ON, a real bash call renders as a TERMINAL card (content + _meta + exit)', async () => {
    // With terminal output advertised, a real bash call emits description then terminal content
    // plus cwd metadata; its result uses terminal output/exit metadata and omits text that would
    // clobber the card.
    harness = await makeBridgeHarness({
      storageDir,
      withBash: true,
      script: [toolCallResponse('c1', 'bash', { command: 'echo hi', description: 'Greet' }), textResponse('done')],
    })
    // Capability lives under clientCapabilities._meta.terminal_output.
    const sessionId = await newSession(harness, { _meta: { terminal_output: true } })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'greet' }] })

    const call = harness.updates.find(u => u.sessionUpdate === 'tool_call')
    if (call?.sessionUpdate !== 'tool_call') throw new Error('expected a tool_call')
    // The description content block FIRST (renders above the card), then a
    // terminal content block keyed by the callId; terminal_info carries the
    // session cwd (the bridge fills it from the session header).
    expect(call.content).toEqual([
      { type: 'content', content: { type: 'text', text: 'Greet' } },
      { type: 'terminal', terminalId: 'c1' },
    ])
    expect((call._meta as { terminal_info?: unknown }).terminal_info).toEqual({ terminal_id: 'c1', cwd: process.cwd() })

    const update = harness.updates.find(u => u.sessionUpdate === 'tool_call_update')
    if (update?.sessionUpdate !== 'tool_call_update') throw new Error('expected a tool_call_update')
    // In terminal mode the text content is OMITTED (a tool_call_update.content
    // REPLACES the call's content — it would clobber the terminal block).
    expect(update.content).toBeUndefined()
    // Output rides on _meta.terminal_output; the parsed exit on _meta.terminal_exit.
    const meta = update._meta as {
      terminal_output?: { terminal_id: string; data: string }
      terminal_exit?: { terminal_id: string; exit_code?: number; signal?: string }
    }
    expect(meta.terminal_output).toEqual({ terminal_id: 'c1', data: 'hi\n' })
    expect(meta.terminal_exit).toEqual({ terminal_id: 'c1', exit_code: 0 })
  })

  it('the terminal capability is snapshotted per-session: a later initialize cannot desync a call/result', async () => {
    // Create the session with terminal support, then disable it connection-wide. The session's
    // snapshot must keep call and result rendering consistent instead of re-reading changed state.
    harness = await makeBridgeHarness({
      storageDir,
      withBash: true,
      script: [toolCallResponse('c1', 'bash', { command: 'echo hi', description: 'Greet' }), textResponse('done')],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { _meta: { terminal_output: true } } })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    // A re-initialize that DROPS the capability after the session exists.
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'greet' }] })

    const call = harness.updates.find(u => u.sessionUpdate === 'tool_call')
    if (call?.sessionUpdate !== 'tool_call') throw new Error('expected a tool_call')
    // Still a terminal card (the session's snapshot, not the mutated connection cap).
    expect((call._meta as { terminal_info?: unknown }).terminal_info).toBeDefined()
    const update = harness.updates.find(u => u.sessionUpdate === 'tool_call_update')
    if (update?.sessionUpdate !== 'tool_call_update') throw new Error('expected a tool_call_update')
    // The result AGREES with the call: terminal output present, content omitted.
    expect(update.content).toBeUndefined()
    expect((update._meta as { terminal_output?: unknown }).terminal_output).toBeDefined()
  })

  it('a throwing tool presenter does not break the turn: the bridge falls back generically', async () => {
    // A buggy tool whose presentCall throws must not fail the live turn — the
    // bridge's presenter contains the throw (logging via its onError sink) and
    // falls back to the generic title=name presentation. Exercises the real
    // bridge wiring of the per-session presenter's error sink.
    harness = await makeBridgeHarness({
      storageDir,
      script: [toolCallResponse('c1', 'kaboom', { x: 1 }), textResponse('done')],
    })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'kaboom',
      description: 'explodes when presented',
      parameters: { x: { type: 'number' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
      presentCall: () => { throw new Error('present boom') },
    }))
    const sessionId = await newSession(harness)
    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(res.stopReason).toBe('end_turn') // the turn completed despite the throw

    const call = harness.updates.find(u => u.sessionUpdate === 'tool_call')
    // Generic fallback: title is the tool name, raw args as rawInput.
    expect(call).toMatchObject({ toolCallId: 'c1', title: 'kaboom', kind: 'other', rawInput: { x: 1 } })
    const update = harness.updates.find(u => u.sessionUpdate === 'tool_call_update')
    expect(update).toMatchObject({ toolCallId: 'c1', status: 'completed' })
  })

  it('a failing tool yields a failed tool_call_update', async () => {
    harness = await makeBridgeHarness({
      storageDir,
      script: [toolCallResponse('c1', 'bash', { command: 'boom' }), textResponse('ok')],
    })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'run a command',
      parameters: { command: { type: 'string' } },
      async execute() { throw new Error('command failed') },
    }))
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'run it' }] })
    const failed = harness.updates.filter(u => u.sessionUpdate === 'tool_call_update' && u.status === 'failed')
    expect(failed).toHaveLength(1)
  })

  it('settles successfully when an earlier turn/end observer throws', async () => {
    // Session contains each post-commit observer failure, so a prepended peer
    // cannot starve the bridge's live turn/end delivery.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('answer')] })
    harness.ctx.on('session/event', (_s, event) => {
      if (event.type === 'turn/end') throw new Error('peer listener boom')
    }, { prepend: true })
    const sessionId = await newSession(harness)
    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(res.stopReason).toBe('end_turn')
  })

  it('still rejects a failed turn when an earlier turn/end observer throws', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [errorResponse('starved boom')] })
    harness.ctx.on('session/event', (_s, event) => {
      if (event.type === 'turn/end') throw new Error('peer listener boom')
    }, { prepend: true })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: starved boom/)
  })

  it('captures and settles the owning turn when an earlier turn-start observer throws', async () => {
    // Turn correlation still reaches the bridge after the throwing peer and
    // captures inflight.turn via the live stream. A throwing turn/start listener
    // Session contains post-commit callbacks independently.
    // The model request and normal turn outcome therefore still occur.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('answer')] })
    harness.ctx.on('session/event', (_s, event) => {
      if (event.type === 'turn/start') throw new Error('peer listener boom on start')
    }, { prepend: true })
    const sessionId = await newSession(harness)
    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('end_turn')
  })

  it('a between-turn injection does not settle the prompt early (message-trigger correlation)', async () => {
    // A plugin injects context (a one-shot injection-triggered turn) right after
    // the prompt is queued but before the prompt's own message turn runs. The
    // bridge must NOT mistake the injection turn's turn/end for the prompt's —
    // it correlates only to message-triggered turns. The prompt settles on its
    // OWN turn with the real model answer.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('real answer')] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    // On the queued prompt, synchronously inject a one-shot context turn (idle
    // inject writes turn/start{injection} → user/message → turn/end). Fire
    // once so it lands between install and the prompt turn.
    let injected = false
    harness.ctx.on('agent/inbox/enqueue', (subject) => {
      if (subject === agent && !injected) {
        injected = true
        agent.inject([{ type: 'text', text: 'ctx note' }], { source: { kind: 'plugin', plugin: 'test' } })
      }
    })
    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(res.stopReason).toBe('end_turn')
    const text = harness.updates
      .filter(u => u.sessionUpdate === 'agent_message_chunk')
      .map(u => (u.content.type === 'text' ? u.content.text : ''))
      .join('')
    expect(text).toContain('real answer')
  })

  it('rejects a second prompt while one is in flight', async () => {
    harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    const sessionId = await newSession(harness)
    // Start the first prompt but do NOT await — it hangs in the model stream.
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] })
    // Give the loop a tick to install the settle + start running.
    await new Promise(r => setTimeout(r, 30))
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .rejects.toThrow(/already in flight/)
    // Cancel to settle the first so the harness disposes cleanly.
    await harness.client.cancel({ sessionId })
    await first
  })

  it('session/cancel aborts a running turn and settles the prompt as cancelled', async () => {
    harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    const sessionId = await newSession(harness)
    const promptDone = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await new Promise(r => setTimeout(r, 30))
    await harness.client.cancel({ sessionId })
    const res = await promptDone
    expect(res.stopReason).toBe('cancelled')
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    await agent.whenIdle()
    const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason).toEqual({ kind: 'aborted' })
  })

  it('cancel right after prompt settles cancelled and leaves the agent idle, no leaked turn', async () => {
    // JSON-RPC timing normally makes this a running mid-step cancellation; pre-step dropping is
    // covered in agent-loop. Here the prompt must settle cancelled, return idle, and clear queued
    // work so the scripted second response cannot leak into another turn.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('answer'), textResponse('leaked')] })
    const sessionId = await newSession(harness)
    const promptDone = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await harness.client.cancel({ sessionId })
    const res = await promptDone
    expect(res.stopReason).toBe('cancelled')
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    await agent.whenIdle()
    const turnStarts = agent.session.events.filter(e => e.type === 'turn/start').length
    expect(turnStarts).toBeLessThanOrEqual(1)
  })

  it('idle session/cancel then session/prompt runs the prompt (no intervening whenIdle)', async () => {
    // The bridge settles cancel synchronously, so exercise the production cancel→prompt race with
    // no `whenIdle()`. An idle cancel must not mark or drop the following prompt.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('real answer')] })
    const sessionId = await newSession(harness)
    // Cancel while idle (no prompt in flight) — a no-op.
    await harness.client.cancel({ sessionId })
    // Immediately prompt, no whenIdle() between.
    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(res.stopReason).toBe('end_turn')
    const text = harness.updates
      .filter(u => u.sessionUpdate === 'agent_message_chunk')
      .map(u => (u.content.type === 'text' ? u.content.text : ''))
      .join('')
    expect(text).toContain('real answer')
  })

  it('mid-stream cancel then an IMMEDIATE next prompt runs (no intervening whenIdle)', async () => {
    // Cancel a running turn and immediately send another prompt without awaiting quiescence. The
    // cancellation marker belongs only to the first turn and must not drop the next request.
    harness = await makeBridgeHarness({ storageDir, script: ['hang', textResponse('next answer')] })
    const sessionId = await newSession(harness)
    const a = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'A' }] })
    await new Promise(r => setTimeout(r, 30))
    await harness.client.cancel({ sessionId })
    expect((await a).stopReason).toBe('cancelled')
    // Immediately — no whenIdle() — send the next prompt.
    const b = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'B' }] })
    expect(b.stopReason).toBe('end_turn')
    const text = harness.updates
      .filter(u => u.sessionUpdate === 'agent_message_chunk')
      .map(u => (u.content.type === 'text' ? u.content.text : ''))
      .join('')
    expect(text).toContain('next answer')
  })

  it('a cancelled turn\'s late turn/end does not settle the NEXT prompt', async () => {
    // Cancellation frees A's slot before its aborted turn/end is appended. Send B in that window;
    // correlation by turn number must prevent A's late closer from settling B as cancelled.
    harness = await makeBridgeHarness({ storageDir, script: ['hang', textResponse('B answer')] })
    const sessionId = await newSession(harness)

    const a = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'A' }] })
    await new Promise(r => setTimeout(r, 30)) // let A start running (turn 1)
    await harness.client.cancel({ sessionId })
    expect((await a).stopReason).toBe('cancelled')

    // B owns the later turn and must complete on its own turn/end.
    const b = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'B' }] })
    expect(b.stopReason).toBe('end_turn')
    const text = harness.updates
      .filter(u => u.sessionUpdate === 'agent_message_chunk')
      .map(u => (u.content.type === 'text' ? u.content.text : ''))
      .join('')
    expect(text).toContain('B answer')
  })
})
