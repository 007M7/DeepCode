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

  it('rejects load when the persisted session cwd differs from the launch dir', async () => {
    // Seed a session on disk whose header.cwd is a DIFFERENT absolute path than
    // the server's launch dir, then load it requesting the launch cwd (so the
    // request-cwd check passes). The bridge must still reject on the persisted
    // header cwd — else it would replay that session while tools run here.
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
    await expect(loader.client.loadSession({ sessionId: 'elsewhere', cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/created in \/some\/other\/workspace/)
    // The rejected load must NOT have constructed/registered a live agent (the
    // cwd is validated from persisted metadata BEFORE resume) — no leak.
    expect(loader.ctx.agents.get('elsewhere')).toBeUndefined()
    // And a fresh newSession still works (the connection is not wedged).
    const ok = await loader.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(ok.sessionId).toBeTruthy()
  })

  it('rejects load for a non-absolute or mismatched cwd', async () => {
    loader = await makeBridgeHarness({ storageDir, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(loader.client.loadSession({ sessionId: 's', cwd: 'rel', mcpServers: [] }))
      .rejects.toThrow(/absolute/)
    await expect(loader.client.loadSession({ sessionId: 's', cwd: '/other', mcpServers: [] }))
      .rejects.toThrow(/launch directory/)
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
