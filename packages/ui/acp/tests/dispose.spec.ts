import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { makeBridgeHarness, textResponse } from './harness.ts'

describe('acp bridge — disposal & HMR safety', () => {
  let storageDir: string

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-dispose-')) })
  afterEach(async () => { await rm(storageDir, { recursive: true, force: true }) })

  it('disposal reaches quiescence: a running turn is aborted and awaited before dispose returns', async () => {
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(AgentId(sessionId))!

    // Start a prompt that hangs in the model stream.
    const promptDone = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    // A resolved teardown is the quiescence boundary.
    await harness.ctx.fiber.dispose()
    expect(agent.status).not.toBe('running')

    const res = await promptDone
    expect(res.stopReason).toBe('cancelled')
  })

  it('after an ACP-only HMR dispose, a late session/new creates no orphan agent (closed guard)', async () => {
    // An ACP-only unload must close creation while shared services remain live.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const before = harness.ctx.agents.list().length
    await harness.acpFiber.dispose() // tear down ONLY the bridge
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/disposed/)
    expect(harness.ctx.agents.list().length).toBe(before)
    await harness.dispose()
  })

  it('an agent created through the bridge is unregistered when ONLY the bridge fiber is disposed', async () => {
    // The caller fiber owns agents created through its traced service proxy.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeDefined()

    await harness.acpFiber.dispose() // tear down ONLY the bridge
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()
    await harness.dispose()
  })

  it('no agent is created by a session/new after the bridge has closed (closed guard)', async () => {
    // Assert registry state because the closed transport rejects the RPC.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const before = harness.ctx.agents.list().length
    await harness.closeClientTransport() // teardown → closed = true
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }).catch(() => {})
    await new Promise(r => setTimeout(r, 10))
    expect(harness.ctx.agents.list().length).toBe(before)
    await harness.dispose()
  })

  it('a client disconnect mid-prompt disposes the session (no registered agent left)', async () => {
    // Disconnect must dispose, not merely idle, the owned agent.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(AgentId(sessionId))!
    // The transport will close before this hanging RPC settles.
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    await harness.closeClientTransport()
    await agent.whenIdle()
    expect(agent.status).toBe('disposed')

    // The shared bridge teardown also removes registry state.
    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId(sessionId))).toBeUndefined()
    await harness.dispose()
  })

  it('a client disconnect racing fiber dispose both reach quiescence (shared teardown)', async () => {
    // Both teardown callers must await the same quiescence boundary.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(AgentId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    const close = harness.closeClientTransport()
    const dispose = harness.ctx.fiber.dispose()
    await Promise.all([close, dispose])
    expect(agent.status).not.toBe('running')
  })

  it('after dispose, session/update listeners are gone (no further updates emitted)', async () => {
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const session = harness.ctx.agents.get(AgentId(sessionId))!.session

    await harness.ctx.fiber.dispose()
    const before = harness.updates.length
    // Append an event directly to the (now-detached) session: the bridge's
    // session/event listener should have been disposed, so no update fires.
    session.append('turn/start', { turn: 99, trigger: { kind: 'message', source: { kind: 'user' } } })
    await new Promise(r => setTimeout(r, 10))
    expect(harness.updates.length).toBe(before)
  })

  it('the final turn closing events are persisted across an AgentHandle dispose (durability)', async () => {
    // Reload from storage to verify final flush precedes session detach.
    const harness = await makeBridgeHarness({ storageDir, script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const liveEvents = harness.ctx.agents.get(AgentId(sessionId))!.session.events.length
    expect(liveEvents).toBeGreaterThan(0)

    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()

    const reloaded = await harness.ctx.sessionPersistence.load(SessionId(sessionId))
    expect(reloaded.events.length).toBe(liveEvents)
    const last = reloaded.events.at(-1)!
    expect(last.type).toBe('turn/end')
    await harness.dispose()
  })

  it('a turn aborted BY the dispose still flushes its closing turn/end to disk (durability, mid-turn)', async () => {
    // A mid-turn dispose must flush its real closer before detaching storage.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(AgentId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    const openTurnEnds = agent.session.events.filter(e => e.type === 'turn/end').length

    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()

    const reloaded = await harness.ctx.sessionPersistence.load(SessionId(sessionId))
    const persistedTurnEnds = reloaded.events.filter(e => e.type === 'turn/end')
    expect(persistedTurnEnds.length).toBe(openTurnEnds + 1)
    expect(persistedTurnEnds.at(-1)!.data.reason).toMatchObject({ kind: 'disposed' })
    await harness.dispose()
  })

  it('per-session AgentHandle dispose leaves sibling agents untouched', async () => {
    // Dispose one handle and assert the sibling remains published.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    const handleA = await harness.ctx.agents.create({
      agentId: AgentId('sib-a'), sessionId: SessionId('sib-a'), agentOptions: { model: 'mock' },
    })
    const handleB = await harness.ctx.agents.create({
      agentId: AgentId('sib-b'), sessionId: SessionId('sib-b'), agentOptions: { model: 'mock' },
    })
    expect(harness.ctx.agents.get(AgentId('sib-a'))).toBe(handleA.agent)
    expect(harness.ctx.agents.get(AgentId('sib-b'))).toBe(handleB.agent)

    await handleA.dispose()
    expect(harness.ctx.agents.get(AgentId('sib-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('sib-a'))).toBeUndefined()
    expect(handleA.agent.status).toBe('disposed')
    expect(harness.ctx.agents.get(AgentId('sib-b'))).toBe(handleB.agent)
    expect(harness.ctx.sessions.get(SessionId('sib-b'))).toBeDefined()
    expect(handleB.agent.status).not.toBe('disposed')
    await harness.dispose()
  })

  it('a throwing agent/disposed listener does not prevent session removal (composite-effect containment)', async () => {
    // Listener failure cannot skip the later session-detach disposer.
    const harness = await makeBridgeHarness({ storageDir, script: [textResponse('ok')] })
    harness.ctx.on('agent/disposed', () => { throw new Error('boom disposed listener') })
    const handle = await harness.ctx.agents.create({
      agentId: AgentId('guard-a'), sessionId: SessionId('guard-a'), agentOptions: { model: 'mock' },
    })
    handle.agent.send([{ type: 'text', text: 'go' }])
    await handle.agent.whenIdle()
    expect(harness.ctx.sessions.get(SessionId('guard-a'))).toBeDefined()

    await handle.dispose()
    expect(harness.ctx.agents.get(AgentId('guard-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('guard-a'))).toBeUndefined() // detach still ran
    await harness.dispose()
  })

  it('concurrent AgentHandle dispose() calls all await the SAME teardown (memoized)', async () => {
    // Concurrent callers must share the in-flight teardown promise.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    const handle = await harness.ctx.agents.create({
      agentId: AgentId('conc-a'), sessionId: SessionId('conc-a'), agentOptions: { model: 'mock' },
    })
    // Gate the final flush to keep teardown observably in flight.
    handle.agent.send([{ type: 'text', text: 'go' }])
    await new Promise(r => setTimeout(r, 30))
    expect(handle.agent.status).toBe('running')
    let releaseFlush!: () => void
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
    harness.ctx.on('session/flush', () => flushGate)

    const first = handle.dispose()
    let firstSettled = false
    void first.then(() => { firstSettled = true })
    await new Promise(r => setTimeout(r, 20))
    expect(firstSettled).toBe(false)

    const second = handle.dispose()
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await new Promise(r => setTimeout(r, 20))
    expect(secondSettled).toBe(false) // memoized: still pending with the first

    releaseFlush()
    await Promise.all([first, second])
    expect(harness.ctx.agents.get(AgentId('conc-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('conc-a'))).toBeUndefined()
    await harness.dispose()
  })
})
