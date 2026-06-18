import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import {
  errorResponse,
  makeBridgeHarness,
  maxTokensResponse,
  textResponse,
  toolCallResponse,
  type BridgeHarness,
} from './harness.ts'

/** Boilerplate: initialize + create one session, returning its id. */
async function newSession(h: BridgeHarness): Promise<string> {
  await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
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

  it('streams a tool call as tool_call then tool_call_update', async () => {
    harness = await makeBridgeHarness({
      storageDir,
      script: [toolCallResponse('c1', 'bash', { command: 'echo hi' }), textResponse('done')],
    })
    harness.ctx.tools.register(defineTool({
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
    expect(toolCalls[0]).toMatchObject({ toolCallId: 'c1', title: 'bash', kind: 'execute', status: 'in_progress' })
    expect(toolUpdates).toHaveLength(1)
    expect(toolUpdates[0]).toMatchObject({ toolCallId: 'c1', status: 'completed' })

    // Ordering invariant: the tool_call precedes its tool_call_update.
    const callIdx = harness.updates.findIndex(u => u.sessionUpdate === 'tool_call')
    const updIdx = harness.updates.findIndex(u => u.sessionUpdate === 'tool_call_update')
    expect(callIdx).toBeLessThan(updIdx)
  })

  it('the REAL bash tool drives the tool-call UI end-to-end: description—command title + console output', async () => {
    // Use the SHIPPING tool (dsh-tool-bash + dsh-bash-local), not an inline
    // stand-in, so this verifies the actual presentCall/presentResult the editor
    // sees (AGENTS.md "prefer the real implementation over a mock in tests").
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

    // presentCall: execute kind, title is "description — command" (an execute
    // card hides rawInput, so the command rides in the title), command in rawInput.
    const call = harness.updates.find(u => u.sessionUpdate === 'tool_call')
    expect(call).toMatchObject({
      toolCallId: 'c1',
      title: 'Print a greeting — echo hello',
      kind: 'execute',
      rawInput: 'echo hello',
      status: 'in_progress',
    })
    // presentResult: the REAL command output, wrapped in a fenced console block.
    const update = harness.updates.find(u => u.sessionUpdate === 'tool_call_update')
    expect(update?.sessionUpdate).toBe('tool_call_update')
    if (update?.sessionUpdate !== 'tool_call_update') throw new Error('expected a tool_call_update')
    expect(update).toMatchObject({ toolCallId: 'c1', status: 'completed' })
    const content = update.content as { content: { type: string; text: string } }[]
    expect(content[0]?.content.text).toBe('```console\nhello\n```')
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
    harness.ctx.tools.register(defineTool({
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
    harness.ctx.tools.register(defineTool({
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

  it('settles via the log fallback when a prior session/event listener throws (starvation)', async () => {
    // A peer session/event listener that runs BEFORE the bridge's listener
    // throws on turn/end (prepend: true puts it first). cordis emit stops at the
    // throw, so the bridge's session/event listener never sees turn/end and
    // cannot settle there. The agent/status idle-fallback must reconcile the
    // prompt from the log so the RPC settles instead of hanging.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('answer')] })
    harness.ctx.on('session/event', (_s, event) => {
      if (event.type === 'turn/end') throw new Error('peer listener boom')
    }, { prepend: true })
    const sessionId = await newSession(harness)
    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(res.stopReason).toBe('end_turn')
  })

  it('log fallback REJECTS when the starved turn ended in error', async () => {
    // Same starvation as above, but the turn fails: the idle-fallback must
    // reject the RPC from the logged turn/end{error}, not resolve.
    harness = await makeBridgeHarness({ storageDir, script: [errorResponse('starved boom')] })
    harness.ctx.on('session/event', (_s, event) => {
      if (event.type === 'turn/end') throw new Error('peer listener boom')
    }, { prepend: true })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: starved boom/)
  })

  it('log fallback infers the owning turn when turn/START capture is starved', async () => {
    // A peer listener throws on turn/START (not turn/end): the bridge never
    // captures inflight.turn via the live stream. A throwing turn/start listener
    // also FAILS the turn (the throw is recorded as the turn's error). Without
    // the watermark inference the fallback would resolve `cancelled` (the bug);
    // with it, it infers the owning turn from the log and REJECTS from that
    // turn's error turn/end. (The model's own error is never reached — the turn
    // failed at start — so the rejection carries the listener's failure.)
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('never runs')] })
    harness.ctx.on('session/event', (_s, event) => {
      if (event.type === 'turn/start') throw new Error('peer listener boom on start')
    }, { prepend: true })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed:/)
  })

  it('a between-turn injection does not settle the prompt early (message-trigger correlation)', async () => {
    // A plugin injects context (a one-shot injection-triggered turn) right after
    // the prompt is queued but before the prompt's own message turn runs. The
    // bridge must NOT mistake the injection turn's turn/end for the prompt's —
    // it correlates only to message-triggered turns. The prompt settles on its
    // OWN turn with the real model answer.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('real answer')] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(sessionId)!
    // On the queued prompt, synchronously inject a one-shot context turn (idle
    // inject writes turn/start{injection} → context/message → turn/end). Fire
    // once so it lands between install and the prompt turn.
    let injected = false
    harness.ctx.on('agent/queued', (subject) => {
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
  })

  it('cancel in the pre-step window still settles the prompt cancelled exactly once', async () => {
    // No script entry is consumed before cancel: cancel immediately after the
    // prompt is sent, before the model step starts. The prompt must still
    // settle cancelled (best-effort abort + settle), not hang.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('late')] })
    const sessionId = await newSession(harness)
    const promptDone = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await harness.client.cancel({ sessionId })
    const res = await promptDone
    expect(res.stopReason).toBe('cancelled')
    // The queued turn may still start after the cancel cleared the in-flight
    // slot (the documented TODO(rfc010-cancel-prestep) best-effort window): its
    // turn-start then fires with no prompt to tag, and the bridge does nothing.
    // Let it run to completion and assert nothing re-settles (no throw, no hang).
    await harness.ctx.agents.get(sessionId)!.whenIdle()
  })

  it('a cancelled turn\'s late turn/end does not settle the NEXT prompt', async () => {
    // Regression: prompt A runs; cancel settles A and frees the slot; A's
    // aborted turn/end is still pending in the loop. Prompt B is sent before
    // A's turn/end arrives. A's late turn/end (an EARLIER turn number) must NOT
    // settle B — B owns a later turn. B then completes on its OWN turn/end.
    harness = await makeBridgeHarness({ storageDir, script: ['hang', textResponse('B answer')] })
    const sessionId = await newSession(harness)

    const a = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'A' }] })
    await new Promise(r => setTimeout(r, 30)) // let A start running (turn 1)
    await harness.client.cancel({ sessionId })
    expect((await a).stopReason).toBe('cancelled')

    // Immediately send B; its turn (2) is distinct from A's (1). If A's late
    // turn/end leaked onto B, B would settle 'cancelled' instead of 'end_turn'.
    const b = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'B' }] })
    expect(b.stopReason).toBe('end_turn')
    const text = harness.updates
      .filter(u => u.sessionUpdate === 'agent_message_chunk')
      .map(u => (u.content.type === 'text' ? u.content.text : ''))
      .join('')
    expect(text).toContain('B answer')
  })
})
