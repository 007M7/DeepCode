import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { makeBridgeHarness, textResponse, toolCallResponse, type BridgeHarness, type CapturedUpdate } from './harness.ts'

/** Concatenate the text of all agent_message_chunk updates. */
function messageText(updates: CapturedUpdate[]): string {
  return updates
    .filter(u => u.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.content.type === 'text' ? u.content.text : ''))
    .join('')
}

describe('acp bridge — session/load replay', () => {
  let storageDir: string
  let live: BridgeHarness | undefined
  let loader: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-load-')) })
  afterEach(async () => {
    if (live) await live.dispose()
    if (loader) await loader.dispose()
    live = loader = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('replays a persisted turn from the event log as session/update on load', async () => {
    // 1. Create a session and run one turn — persistence writes the event log.
    live = await makeBridgeHarness({ storageDir, script: [textResponse('remembered answer')] })
    await live.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await live.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await live.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'remember this' }] })
    // Dispose to flush + release; the on-disk log persists.
    await live.dispose()
    live = undefined

    // 2. A fresh bridge loads the same session id and must replay the turn.
    loader = await makeBridgeHarness({ storageDir, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(res).toBeDefined()

    // The replayed updates reconstruct the assistant text from the event log
    // (assistant/chunk → agent_message_chunk), NOT from deriveMessages.
    expect(messageText(loader.updates)).toBe('remembered answer')

    // And the USER side of the turn replays too (user/message →
    // user_message_chunk), so the editor transcript shows both sides.
    const userText = loader.updates
      .filter(u => u.sessionUpdate === 'user_message_chunk')
      .map(u => (u.content.type === 'text' ? u.content.text : ''))
      .join('')
    expect(userText).toBe('remember this')
  })

  it('replays a persisted tool call with the TOOL-OWNED presentation (title/rawInput/console output)', async () => {
    // Persist a real bash call, then replay it through a fresh bridge. A throwaway presenter pairs
    // call and result in log order so replay uses the shipping tool's same cards as live streaming.
    live = await makeBridgeHarness({
      storageDir,
      withBash: true,
      script: [toolCallResponse('c1', 'bash', { command: 'echo hello', description: 'Print a greeting' }), textResponse('done')],
    })
    await live.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await live.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await live.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'greet' }] })
    await live.dispose()
    live = undefined

    // A fresh bridge — also with the real bash tool, since the presentation is
    // resolved from the live registry at replay time — loads the session.
    loader = await makeBridgeHarness({ storageDir, withBash: true, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })

    const call = loader.updates.find(u => u.sessionUpdate === 'tool_call')
    expect(call).toMatchObject({ toolCallId: 'c1', title: 'echo hello', kind: 'execute', rawInput: 'echo hello' })
    if (call?.sessionUpdate !== 'tool_call') throw new Error('expected a tool_call')
    // Capability OFF on this loader: the description renders as a content block, no terminal block.
    expect(call.content).toEqual([{ type: 'content', content: { type: 'text', text: 'Print a greeting' } }])
    const update = loader.updates.find(u => u.sessionUpdate === 'tool_call_update')
    expect(update?.sessionUpdate).toBe('tool_call_update')
    if (update?.sessionUpdate !== 'tool_call_update') throw new Error('expected a tool_call_update')
    expect(update).toMatchObject({ toolCallId: 'c1', status: 'completed' })
    const content = update.content as { content: { text: string } }[]
    expect(content[0]?.content.text).toBe('```console\nhello\n```')
  })

  it('replays a persisted todo/write as a plan sessionUpdate on load', async () => {
    // A persisted `todo/write` must replay as an ACP plan update so a reopened editor sees the
    // current plan, not just the tool transcript.
    live = await makeBridgeHarness({
      storageDir,
      withTodo: true,
      script: [
        toolCallResponse('c1', 'todo_write', {
          todos: [
            { content: 'first step', status: 'in_progress' },
            { content: 'second step', status: 'pending' },
          ],
        }),
        textResponse('planned'),
      ],
    })
    await live.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await live.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await live.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'plan it' }] })
    await live.dispose()
    live = undefined

    loader = await makeBridgeHarness({ storageDir, withTodo: true, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })

    const plan = loader.updates.find(u => u.sessionUpdate === 'plan')
    expect(plan).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'first step', priority: 'medium', status: 'in_progress' },
        { content: 'second step', priority: 'medium', status: 'pending' },
      ],
    })
  })

  it('replays a persisted bash call as a TERMINAL card when the loader advertises the capability', async () => {
    // The presentation is resolved at replay time, so a loader that advertised
    // _meta.terminal_output must reconstruct the terminal card (content + _meta)
    // from the persisted log — identical to how it would have streamed live.
    live = await makeBridgeHarness({
      storageDir,
      withBash: true,
      script: [toolCallResponse('c1', 'bash', { command: 'echo hi', description: 'Greet' }), textResponse('done')],
    })
    await live.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await live.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await live.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'greet' }] })
    await live.dispose()
    live = undefined

    loader = await makeBridgeHarness({ storageDir, withBash: true, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { _meta: { terminal_output: true } } })
    await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })

    const call = loader.updates.find(u => u.sessionUpdate === 'tool_call')
    if (call?.sessionUpdate !== 'tool_call') throw new Error('expected a tool_call')
    // Replay reconstructs the terminal card: description block, then terminal block.
    expect(call.content).toEqual([
      { type: 'content', content: { type: 'text', text: 'Greet' } },
      { type: 'terminal', terminalId: 'c1' },
    ])
    expect((call._meta as { terminal_info?: unknown }).terminal_info).toEqual({ terminal_id: 'c1', cwd: process.cwd() })
    const update = loader.updates.find(u => u.sessionUpdate === 'tool_call_update')
    if (update?.sessionUpdate !== 'tool_call_update') throw new Error('expected a tool_call_update')
    // Terminal mode: content omitted, output + exit on _meta — matching live.
    expect(update.content).toBeUndefined()
    const meta = update._meta as { terminal_output?: { data: string }; terminal_exit?: { exit_code?: number } }
    expect(meta.terminal_output?.data).toBe('hi\n')
    expect(meta.terminal_exit?.exit_code).toBe(0)
  })

  it('a load whose resume finishes after a client disconnect leaks no live session', async () => {
    // Stall persistence so transport closes while resume is pending. Whether the SDK rejects first
    // or the bridge's post-await guard fires, no agent may survive for the dead connection.
    live = await makeBridgeHarness({ storageDir, script: [textResponse('x')] })
    await live.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await live.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await live.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await live.dispose()
    live = undefined

    loader = await makeBridgeHarness({ storageDir, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const realLoad = loader.ctx.sessionPersistence.load.bind(loader.ctx.sessionPersistence)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    loader.ctx.sessionPersistence.load = async (id) => { await gate; return realLoad(id) }

    const loadResult = loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
      .then(() => 'resolved' as const, () => 'rejected' as const)
    await loader.closeClientTransport() // teardown sets `closed` while load is gated
    release()                            // resume() finishes AFTER teardown
    expect(await loadResult).toBe('rejected')
    // No live agent was installed for the closed connection.
    expect(loader.ctx.agents.get(AgentId(sessionId))).toBeUndefined()
  })

  it('rejects load when the requested cwd does not match the persisted session cwd', async () => {
    // Seed a session on disk whose header.cwd is a DIFFERENT absolute path than the server's
    // launch dir. Resume must retain the header cwd and route bash there rather than reject the
    // mismatch or substitute the server cwd.
    loader = await makeBridgeHarness({ storageDir, script: [] })
    const otherCwd = '/some/other/workspace'
    await loader.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SessionId('elsewhere'), createdAt: 1, cwd: otherCwd,
    })
    await loader.ctx.sessionPersistence.append(SessionId('elsewhere'), [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ])

    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(loader.client.loadSession({ sessionId: 'elsewhere', cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/cwd mismatch/)
    expect(loader.ctx.agents.get(AgentId('elsewhere'))).toBeUndefined()

    const res = await loader.client.loadSession({ sessionId: 'elsewhere', cwd: `${otherCwd}/.`, mcpServers: [] })
    expect(res).toBeDefined()
    expect(loader.ctx.agents.get(AgentId('elsewhere'))!.session.header.cwd).toBe(otherCwd)
  })

  it('rejects load for a non-absolute cwd (still required to be absolute)', async () => {
    loader = await makeBridgeHarness({ storageDir, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(loader.client.loadSession({ sessionId: 's', cwd: 'rel', mcpServers: [] }))
      .rejects.toThrow(/absolute/)
  })

  it('lets persistence reject a load for an unknown id after metadata lookup misses', async () => {
    loader = await makeBridgeHarness({ storageDir, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(loader.client.loadSession({ sessionId: 'missing', cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/Internal error/)
  })

  it('rejects loading a persisted session that has NO cwd (would silently run in the launch dir)', async () => {
    // A legacy/external log without `header.cwd` must be rejected; the request cwd does not override
    // it, and accepting would let bash silently fall back to the server launch directory.
    loader = await makeBridgeHarness({ storageDir, script: [] })
    await loader.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SessionId('legacy'), createdAt: 1, // no cwd
    })
    await loader.ctx.sessionPersistence.append(SessionId('legacy'), [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(loader.client.loadSession({ sessionId: 'legacy', cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/no absolute persisted cwd/)
    // Rejected BEFORE resume (metadata-only check) — no agent was registered, so
    // the id is not wedged: a later attempt hits the same clean rejection, not a
    // duplicate-registration error.
    expect(loader.ctx.agents.get(AgentId('legacy'))).toBeUndefined()
    await expect(loader.client.loadSession({ sessionId: 'legacy', cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/no absolute persisted cwd/)
  })

  it('allows loading alongside an existing session but rejects re-loading the SAME id', async () => {
    // Multi-session: a load can coexist with a live session, but loading an id
    // that is already live is rejected (it is already loaded).
    live = await makeBridgeHarness({ storageDir, script: [textResponse('one')] })
    await live.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await live.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await live.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    // A different new session coexists.
    const other = await live.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(other.sessionId).not.toBe(sessionId)
    // Re-loading the already-live id is rejected.
    await expect(live.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/already loaded/)
  })
})
