import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness, type CapturedUpdate } from './harness.ts'

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

  it('a load whose resume finishes after a client disconnect leaks no live session', async () => {
    // A session/load is mid-resume() when the client transport closes. The load
    // must NOT end up with a live registered agent for the connection that is
    // already gone. (The bridge's post-await `closed` guard backs this on real
    // stdio; here the SDK rejects the in-flight request on close — either way no
    // agent survives.) Stall persistence so resume() is pending across the close.
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
    expect(loader.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('loads a session whose persisted cwd differs from the launch dir (honors per-session cwd)', async () => {
    // Seed a session on disk whose header.cwd is a DIFFERENT absolute path than
    // the server's launch dir. The bridge must LOAD it (per-session cwd is
    // honored — the resumed session keeps header.cwd, and bash routes there), no
    // longer reject on a mismatch.
    loader = await makeBridgeHarness({ storageDir, script: [] })
    const otherCwd = '/some/other/workspace'
    await loader.ctx.sessionPersistence.create({
      version: 1, id: SessionId('elsewhere'), createdAt: 1, cwd: otherCwd, updatedAt: 1,
    })
    await loader.ctx.sessionPersistence.append(SessionId('elsewhere'), [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ])

    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // Load succeeds even though the requested cwd is the launch dir, not otherCwd.
    const res = await loader.client.loadSession({ sessionId: 'elsewhere', cwd: process.cwd(), mcpServers: [] })
    expect(res).toBeDefined()
    // The resumed session retains its ORIGINAL workspace cwd (so bash runs there).
    expect(loader.ctx.agents.get('elsewhere')!.session.header.cwd).toBe(otherCwd)
  })

  it('rejects load for a non-absolute cwd (still required to be absolute)', async () => {
    loader = await makeBridgeHarness({ storageDir, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(loader.client.loadSession({ sessionId: 's', cwd: 'rel', mcpServers: [] }))
      .rejects.toThrow(/absolute/)
  })

  it('rejects loading a persisted session that has NO cwd (would silently run in the launch dir)', async () => {
    // A legacy / externally-created session log with no header.cwd. The bridge
    // must reject the load rather than accept it and let bash silently fall back
    // to the server's launch dir (the request cwd does not override the header).
    loader = await makeBridgeHarness({ storageDir, script: [] })
    await loader.ctx.sessionPersistence.create({
      version: 1, id: SessionId('legacy'), createdAt: 1, updatedAt: 1, // no cwd
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
    expect(loader.ctx.agents.get('legacy')).toBeUndefined()
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
