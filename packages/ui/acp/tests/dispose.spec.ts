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

    // Dispose the whole context. The bridge's teardown must abort the agent and
    // AWAIT whenIdle() — so right after dispose resolves, the agent is settled
    // (not still running). Proves disposal waited, not just requested.
    await harness.ctx.fiber.dispose()
    expect(agent.status).not.toBe('running')

    // The in-flight prompt settled (cancelled) rather than hanging forever.
    const res = await promptDone
    expect(res.stopReason).toBe('cancelled')
  })

  it('after an ACP-only HMR dispose, a late session/new creates no orphan agent (closed guard)', async () => {
    // Dispose JUST the bridge's fiber (an HMR reload) while agents/agent-loop stay up and the
    // transport is still live.
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
    // The factory (`ctx.agents.create`) is reached through the bridge's traceable service
    // proxy, so `AgentLoop.start`'s `this.ctx.effect(...)` registration binds to the CALLER
    // context — the bridge fiber — not the AgentLoop fiber.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeDefined()

    await harness.acpFiber.dispose() // tear down ONLY the bridge
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()
    await harness.dispose()
  })

  it('no agent is created by a session/new after the bridge has closed (closed guard)', async () => {
    // After teardown (here a client disconnect sets `closed`), a late `session/new` must not
    // create an orphan agent the bridge can no longer drive/settle.
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
    // The ACP transport closes (editor quits) while a turn runs.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(AgentId(sessionId))!
    // Start a prompt that hangs in the model stream. The prompt RPC will never
    // return (its transport is severed), so do not await it.
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    // Sever the transport — the bridge's conn.closed teardown runs and drives the
    // agent's AgentHandle dispose to quiescence on its OWN (before any dispose()).
    await harness.closeClientTransport()
    await agent.whenIdle()
    // The agent's loop has stopped: status `disposed`.
    expect(agent.status).toBe('disposed')

    // Await bridge quiescence without disposing root agent and session services.
    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId(sessionId))).toBeUndefined()
    await harness.dispose()
  })

  it('a client disconnect racing fiber dispose both reach quiescence (shared teardown)', async () => {
    // conn.closed teardown and ctx.fiber.dispose() can fire near-simultaneously.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(AgentId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    // Fire both teardown paths without awaiting the first, then await both.
    const close = harness.closeClientTransport()
    const dispose = harness.ctx.fiber.dispose()
    await Promise.all([close, dispose])
    // After BOTH settle, the agent has fully drained (not still running).
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
    // The teardown-ORDER guarantee: a per-agent dispose must stop the loop, AWAIT its exit (so
    // the loop's final `turn/end` + `session/flush` fire through the still-attached
    // `session.onAppend` → `session/event`), and only THEN detach onAppend + remove the
    // session.
    const harness = await makeBridgeHarness({ storageDir, script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const liveEvents = harness.ctx.agents.get(AgentId(sessionId))!.session.events.length
    expect(liveEvents).toBeGreaterThan(0)

    // Tear down JUST the bridge (the AgentHandle dispose runs to quiescence).
    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()

    // Re-load the session from disk: every live event (incl. the closing
    // turn/end) was flushed before the session was detached.
    const reloaded = await harness.ctx.sessionPersistence.load(SessionId(sessionId))
    expect(reloaded.events.length).toBe(liveEvents)
    const last = reloaded.events.at(-1)!
    expect(last.type).toBe('turn/end')
    await harness.dispose()
  })

  it('a turn aborted BY the dispose still flushes its closing turn/end to disk (durability, mid-turn)', async () => {
    // The teardown-order contract only earns its keep when the closing events are produced BY
    // the dispose itself.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(AgentId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    // The turn is OPEN in the log (turn/start appended, no turn/end yet).
    const openTurnEnds = agent.session.events.filter(e => e.type === 'turn/end').length

    // Dispose JUST the bridge: a fiber unload that must STILL honor the ordered
    // teardown (the composite effect runs its disposer chain as a unit).
    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(AgentId(sessionId))).toBeUndefined()

    // The loop's own `turn/end {disposed}` is on disk (re-load: the world, not
    // self-report) — NOT a crash-recovery `interrupted` substitute.
    const reloaded = await harness.ctx.sessionPersistence.load(SessionId(sessionId))
    const persistedTurnEnds = reloaded.events.filter(e => e.type === 'turn/end')
    expect(persistedTurnEnds.length).toBe(openTurnEnds + 1)
    expect(persistedTurnEnds.at(-1)!.data.reason).toMatchObject({ kind: 'disposed' })
    await harness.dispose()
  })

  it('per-session AgentHandle dispose leaves sibling agents untouched', async () => {
    // The factory returns a per-agent AgentHandle whose dispose() tears down EXACTLY that agent
    // + its session — RFC 011 isolation.
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
    // A is gone — unregistered AND its session removed from the store.
    expect(harness.ctx.agents.get(AgentId('sib-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('sib-a'))).toBeUndefined()
    expect(handleA.agent.status).toBe('disposed')
    // B is wholly unaffected.
    expect(harness.ctx.agents.get(AgentId('sib-b'))).toBe(handleB.agent)
    expect(harness.ctx.sessions.get(SessionId('sib-b'))).toBeDefined()
    expect(handleB.agent.status).not.toBe('disposed')
    await harness.dispose()
  })

  it('a throwing agent/disposed listener does not prevent session removal (composite-effect containment)', async () => {
    // The AgentHandle teardown folds session-detach, register, and loop-stop into one composite
    // effect whose disposers run as a `.then()` chain.
    const harness = await makeBridgeHarness({ storageDir, script: [textResponse('ok')] })
    harness.ctx.on('agent/disposed', () => { throw new Error('boom disposed listener') })
    const handle = await harness.ctx.agents.create({
      agentId: AgentId('guard-a'), sessionId: SessionId('guard-a'), agentOptions: { model: 'mock' },
    })
    handle.agent.send([{ type: 'text', text: 'go' }])
    await handle.agent.whenIdle()
    expect(harness.ctx.sessions.get(SessionId('guard-a'))).toBeDefined()

    // Dispose: the throwing listener must NOT break the chain before detach.
    await handle.dispose()
    expect(harness.ctx.agents.get(AgentId('guard-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('guard-a'))).toBeUndefined() // detach still ran
    await harness.dispose()
  })

  it('concurrent AgentHandle dispose() calls all await the SAME teardown (memoized)', async () => {
    // The handle's dispose() must memoize: the underlying cordis effect disposer is
    // single-shot, so a second dispose() while the first is mid-teardown would otherwise
    // resolve IMMEDIATELY (effect epoch already cleared) — before the first call's await
    // agent.done + final flush finished.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    const handle = await harness.ctx.agents.create({
      agentId: AgentId('conc-a'), sessionId: SessionId('conc-a'), agentOptions: { model: 'mock' },
    })
    // Drive a turn that hangs in the model stream, so the loop is mid-turn when
    // disposed — its exit runs a final session/flush we can gate to hold the
    // teardown observably in-flight.
    handle.agent.send([{ type: 'text', text: 'go' }])
    await new Promise(r => setTimeout(r, 30))
    expect(handle.agent.status).toBe('running')
    let releaseFlush!: () => void
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
    harness.ctx.on('session/flush', () => flushGate)

    // First dispose enters teardown (aborts the hanging step) and blocks in the
    // gated final flush.
    const first = handle.dispose()
    let firstSettled = false
    void first.then(() => { firstSettled = true })
    await new Promise(r => setTimeout(r, 20))
    expect(firstSettled).toBe(false)

    // Second dispose MUST await the same in-flight teardown, not resolve early.
    const second = handle.dispose()
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await new Promise(r => setTimeout(r, 20))
    expect(secondSettled).toBe(false) // memoized: still pending with the first

    // Release the flush; both resolve together and the session is gone.
    releaseFlush()
    await Promise.all([first, second])
    expect(harness.ctx.agents.get(AgentId('conc-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('conc-a'))).toBeUndefined()
    await harness.dispose()
  })
})
