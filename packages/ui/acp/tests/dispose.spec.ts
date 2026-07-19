import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse } from './harness.ts'

describe('acp bridge — disposal & HMR safety', () => {
  let storageDir: string

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-dispose-')) })
  afterEach(async () => { await rm(storageDir, { recursive: true, force: true }) })

  it('disposal reaches quiescence: a running turn is aborted and awaited before dispose returns', async () => {
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

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
    // Dispose JUST the bridge's fiber (an HMR reload) while agents/agent-loop
    // stay up and the transport is still live. A late session/new must hit the
    // `closed` guard and reject — NOT create an agent the disposed bridge can no
    // longer stream or settle. Verify the world: no agent appeared.
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
    // The factory (`ctx.agents.create`) is reached through the bridge's
    // traceable service proxy, so `AgentLoop.start`'s `this.ctx.effect(...)`
    // registration binds to the CALLER context — the bridge fiber — not the
    // AgentLoop fiber. Disposing JUST the bridge fiber (an ACP-only HMR reload)
    // must therefore reclaim the agent's registry entry, even though agents/
    // agent-loop stay up. This pins the fiber-ownership the bridge's teardown
    // doc comment relies on; if a refactor rebinds the registration to the
    // AgentLoop fiber, the agent would survive bridge dispose and this fails.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeDefined()

    await harness.acpFiber.dispose() // tear down ONLY the bridge
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    await harness.dispose()
  })

  it('no agent is created by a session/new after the bridge has closed (closed guard)', async () => {
    // After teardown (here a client disconnect sets `closed`), a late
    // `session/new` must NOT create an orphan agent the bridge can no longer
    // drive/settle. The transport is gone so the RPC rejects; assert the world:
    // no new agent appeared in the registry.
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
    // The ACP transport closes (editor quits) while a turn runs. The bridge must
    // settle the in-flight prompt cancelled and DISPOSE the agent (the session's
    // per-agent AgentHandle teardown) rather than leaving an orphaned running —
    // or even idled-but-still-registered — agent whose updates are swallowed.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
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

    // Await the bridge teardown to completion WITHOUT tearing down the root
    // agents/sessions services (so we can still query them). acpFiber.dispose()
    // invokes the SAME memoized quiesce() the disconnect started and awaits its
    // promise — which resolves only after every rec.dispose() (loop exit +
    // session removal) has finished, closing the whenIdle()/owned.dispose()
    // microtask race. The AgentHandle dispose has run: the agent is unregistered
    // and its session removed from the store, not merely idled (the old
    // behavior). The services live on the root ctx, so they survive this.
    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId(sessionId))).toBeUndefined()
    await harness.dispose()
  })

  it('a client disconnect racing fiber dispose both reach quiescence (shared teardown)', async () => {
    // conn.closed teardown and ctx.fiber.dispose() can fire near-simultaneously.
    // They must share one teardown promise: dispose() must NOT return before the
    // disconnect teardown's whenIdle() has settled (a `record === undefined`-only
    // guard would let the second caller return early mid-teardown).
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
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
    const session = harness.ctx.agents.get(SessionId(sessionId))!.session

    await harness.ctx.fiber.dispose()
    const before = harness.updates.length
    // Append an event directly to the (now-detached) session: the bridge's
    // session/event listener should have been disposed, so no update fires.
    session.append('turn/start', { turn: 99, trigger: { kind: 'message', source: { kind: 'user' } } })
    await new Promise(r => setTimeout(r, 10))
    expect(harness.updates.length).toBe(before)
  })

  it('the final turn closing events are persisted across an AgentHandle dispose (durability)', async () => {
    // The teardown-ORDER guarantee: a per-agent dispose must stop the loop,
    // AWAIT its exit (so the loop's final `turn/end` + `session/flush` fire
    // through the still-attached store observer → `session/event`), and only
    // THEN remove its publication hooks and session entry. If the order were inverted
    // (detach first), the closing events would never reach persistence. Drive a
    // CLEAN turn to completion, dispose JUST the bridge, then re-load the
    // persisted log from disk and assert the closing turn/end is on disk — the
    // world, not the agent's self-report.
    const harness = await makeBridgeHarness({ storageDir, script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const liveEvents = harness.ctx.agents.get(SessionId(sessionId))!.session.events.length
    expect(liveEvents).toBeGreaterThan(0)

    // Tear down JUST the bridge (the AgentHandle dispose runs to quiescence).
    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()

    // Re-load the session from disk: every live event (incl. the closing
    // turn/end) was flushed before the session was detached.
    const reloaded = await harness.ctx.sessionPersistence.load(SessionId(sessionId))
    expect(reloaded.events.length).toBe(liveEvents)
    const last = reloaded.events.at(-1)!
    expect(last.type).toBe('turn/end')
    await harness.dispose()
  })

  it('a turn aborted BY the dispose still flushes its closing turn/end to disk (durability, mid-turn)', async () => {
    // The teardown-order contract only earns its keep when the closing events are
    // produced BY the dispose itself. Here the model stream HANGS, so the turn is
    // still open when teardown runs: the composite agent effect stops the loop,
    // the loop unwinds and appends `turn/end {disposed}` + runs its final
    // `session/flush` — all while the store-owned publication hooks are still attached (the session
    // detach is the LAST disposer in the same effect's LIFO chain) — and only
    // THEN is the session detached. If the order were inverted (or the session
    // were a racing SIBLING effect), the abort-produced `turn/end` would never
    // reach disk and a re-load would instead show crash-recovery's synthetic
    // `interrupted` closer. Re-load from disk and assert the REAL `disposed`
    // reason landed — proving the loop's own closing event was captured, not a
    // recovered substitute.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')
    // The turn is OPEN in the log (turn/start appended, no turn/end yet).
    const openTurnEnds = agent.session.events.filter(e => e.type === 'turn/end').length

    // Dispose JUST the bridge: a fiber unload that must STILL honor the ordered
    // teardown (the composite effect runs its disposer chain as a unit).
    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()

    // The loop's own `turn/end {disposed}` is on disk (re-load: the world, not
    // self-report) — NOT a crash-recovery `interrupted` substitute.
    const reloaded = await harness.ctx.sessionPersistence.load(SessionId(sessionId))
    const persistedTurnEnds = reloaded.events.filter(e => e.type === 'turn/end')
    expect(persistedTurnEnds.length).toBe(openTurnEnds + 1)
    expect(persistedTurnEnds.at(-1)!.data.reason).toMatchObject({ kind: 'disposed' })
    await harness.dispose()
  })

  it('per-session AgentHandle dispose leaves sibling agents untouched', async () => {
    // The factory returns a per-agent AgentHandle whose dispose() tears down
    // EXACTLY that agent + its session — RFC 011 isolation. Create two agents
    // directly through the registry factory (the same path the ACP bridge uses),
    // dispose one handle, and assert the other survives, registered and
    // queryable, with its session still in the store.
    const harness = await makeBridgeHarness({ storageDir, script: [] })
    const handleA = await harness.ctx.agents.create({
      sessionId: SessionId('sib-a'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    const handleB = await harness.ctx.agents.create({
      sessionId: SessionId('sib-b'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(harness.ctx.agents.get(SessionId('sib-a'))).toBe(handleA.agent)
    expect(harness.ctx.agents.get(SessionId('sib-b'))).toBe(handleB.agent)

    await handleA.dispose()
    // A is gone — unregistered AND its session removed from the store.
    expect(harness.ctx.agents.get(SessionId('sib-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('sib-a'))).toBeUndefined()
    expect(handleA.agent.status).toBe('disposed')
    // B is wholly unaffected.
    expect(harness.ctx.agents.get(SessionId('sib-b'))).toBe(handleB.agent)
    expect(harness.ctx.sessions.get(SessionId('sib-b'))).toBeDefined()
    expect(handleB.agent.status).not.toBe('disposed')
    await harness.dispose()
  })

  it('a throwing agent/disposed listener does not prevent session removal (composite-effect containment)', async () => {
    // The AgentHandle teardown folds session-detach, register, and loop-stop
    // into ONE composite effect whose disposers run as a `.then()` chain. The
    // register disposer emits `agent/disposed`; if a listener throws and the
    // emit is UNCONTAINED, the rejected chain skips the LATER session-detach
    // disposer — stranding the session in the store with its publication hooks attached (a
    // leak AND a durability hole, since the new design relies on detach
    // running). The emit must be contained. Register a throwing listener, drive
    // a clean turn, dispose, and assert the session was STILL removed.
    const harness = await makeBridgeHarness({ storageDir, script: [textResponse('ok')] })
    harness.ctx.on('agent/disposed', () => { throw new Error('boom disposed listener') })
    const handle = await harness.ctx.agents.create({
      sessionId: SessionId('guard-a'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.send([{ type: 'text', text: 'go' }])
    await handle.agent.whenIdle()
    expect(harness.ctx.sessions.get(SessionId('guard-a'))).toBeDefined()

    // Dispose: the throwing listener must NOT break the chain before detach.
    await handle.dispose()
    expect(harness.ctx.agents.get(SessionId('guard-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('guard-a'))).toBeUndefined() // detach still ran
    await harness.dispose()
  })

  it('concurrent AgentHandle dispose() calls all await the SAME teardown (memoized)', async () => {
    // The handle's dispose() must memoize: the underlying cordis effect disposer
    // is single-shot, so a second dispose() while the first is mid-teardown would
    // otherwise resolve IMMEDIATELY (effect epoch already cleared) — before the
    // first call's await agent.done + final flush finished. Every caller must
    // observe the same quiescence boundary.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    const handle = await harness.ctx.agents.create({
      sessionId: SessionId('conc-a'), agentOptions: { provider: 'mock', model: 'mock' },
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
    expect(harness.ctx.agents.get(SessionId('conc-a'))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId('conc-a'))).toBeUndefined()
    await harness.dispose()
  })
})
