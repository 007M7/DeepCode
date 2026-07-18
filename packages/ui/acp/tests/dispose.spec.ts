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

    // Teardown must abort and await the loop: once it resolves the agent is settled, and the
    // hanging prompt itself completes as cancelled rather than remaining pending.
    await harness.ctx.fiber.dispose()
    expect(agent.status).not.toBe('running')

    const res = await promptDone
    expect(res.stopReason).toBe('cancelled')
  })

  it('after an ACP-only HMR dispose, a late session/new creates no orphan agent (closed guard)', async () => {
    // Unload only the bridge while transport and shared services remain live. Its closed guard must
    // reject late creation before an orphan agent can enter the registry.
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
    // The traced service proxy binds loop registration to the caller (bridge) fiber. ACP-only
    // disposal must therefore reclaim the agent even while agent-loop itself remains mounted.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeDefined()

    await harness.acpFiber.dispose() // tear down ONLY the bridge
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()
    await harness.dispose()
  })

  it('no agent is created by a session/new after the bridge has closed (closed guard)', async () => {
    // Disconnect sets the closed guard and severs the RPC, so registry state—not the rejection
    // shape—proves a late request did not create an undriveable agent.
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
    // Disconnect mid-stream must dispose, not merely idle, the owned agent; otherwise updates would
    // be swallowed while a registered session survived without a client.
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

    // Await the same memoized bridge teardown without removing root services. It must finish the
    // AgentHandle teardown and remove both registry records, not just stop the loop.
    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId(sessionId))).toBeUndefined()
    await harness.dispose()
  })

  it('a client disconnect racing fiber dispose both reach quiescence (shared teardown)', async () => {
    // Transport close and fiber disposal can race. Both must await one memoized teardown; a guard
    // based only on record removal could let the second caller return while the first still drains.
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
    // AgentHandle teardown stops and awaits the loop, flushes through still-attached store hooks,
    // then detaches the session. Reloading verifies that order from durable state.
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
    // Here disposal itself makes the loop append `turn/end {disposed}` and flush. Reload must find
    // that real closer, not crash recovery's synthetic `interrupted`, proving detach ran last.
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
    // A per-session handle owns exactly one agent and session. Dispose A and assert B remains fully
    // published, which guards against context-wide teardown.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    const handleA = await harness.ctx.agents.create({
      agentId: AgentId('sib-a'), sessionId: SessionId('sib-a'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    const handleB = await harness.ctx.agents.create({
      agentId: AgentId('sib-b'), sessionId: SessionId('sib-b'), agentOptions: { provider: 'mock', model: 'mock' },
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
    // Composite disposers run in sequence. A throwing `agent/disposed` listener must be contained or
    // it would skip later session detach, leaking publication hooks and creating a durability hole.
    const harness = await makeBridgeHarness({ storageDir, script: [textResponse('ok')] })
    harness.ctx.on('agent/disposed', () => { throw new Error('boom disposed listener') })
    const handle = await harness.ctx.agents.create({
      agentId: AgentId('guard-a'), sessionId: SessionId('guard-a'), agentOptions: { provider: 'mock', model: 'mock' },
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
    // The Cordis effect disposer is single-shot and would let a second call return after its epoch
    // clears. AgentHandle must memoize the whole async teardown so every caller awaits quiescence.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    const handle = await harness.ctx.agents.create({
      agentId: AgentId('conc-a'), sessionId: SessionId('conc-a'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    // A hanging turn makes disposal produce a final flush; gate it so the second call arrives while
    // teardown is observably in flight.
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
