import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness } from './harness.ts'

describe('acp bridge — disposal & HMR safety', () => {
  let storageDir: string

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-dispose-')) })
  afterEach(async () => { await rm(storageDir, { recursive: true, force: true }) })

  it('disposal reaches quiescence: a running turn is aborted and awaited before dispose returns', async () => {
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(sessionId)!

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
    expect(harness.ctx.agents.get(sessionId)).toBeDefined()

    await harness.acpFiber.dispose() // tear down ONLY the bridge
    expect(harness.ctx.agents.get(sessionId)).toBeUndefined()
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

  it('a client disconnect mid-prompt tears the session down to quiescence', async () => {
    // The ACP transport closes (editor quits) while a turn runs. The bridge must
    // settle the in-flight prompt cancelled and abort+drain the agent rather
    // than leaving an orphaned running agent whose updates are swallowed.
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(sessionId)!
    // Start a prompt that hangs in the model stream. The prompt RPC will never
    // return (its transport is severed), so do not await it.
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await new Promise(r => setTimeout(r, 30))
    expect(agent.status).toBe('running')

    // Sever the transport — the bridge's conn.closed teardown runs and drives
    // the agent to quiescence on its OWN (assert before any dispose() runs).
    await harness.closeClientTransport()
    await agent.whenIdle()
    expect(agent.status).toBe('idle')

    await harness.dispose() // idempotent with the close teardown
  })

  it('a client disconnect racing fiber dispose both reach quiescence (shared teardown)', async () => {
    // conn.closed teardown and ctx.fiber.dispose() can fire near-simultaneously.
    // They must share one teardown promise: dispose() must NOT return before the
    // disconnect teardown's whenIdle() has settled (a `record === undefined`-only
    // guard would let the second caller return early mid-teardown).
    const harness = await makeBridgeHarness({ storageDir, script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(sessionId)!
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
    const session = harness.ctx.agents.get(sessionId)!.session

    await harness.ctx.fiber.dispose()
    const before = harness.updates.length
    // Append an event directly to the (now-detached) session: the bridge's
    // session/event listener should have been disposed, so no update fires.
    session.append('turn/start', { turn: 99, trigger: { kind: 'message', source: { kind: 'user' } } })
    await new Promise(r => setTimeout(r, 10))
    expect(harness.updates.length).toBe(before)
  })
})
