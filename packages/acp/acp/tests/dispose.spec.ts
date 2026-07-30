import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP connection ownership', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('disposal cancels a running prompt and awaits agent teardown', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(agent.status).toBe('running') })

    await harness.acpFiber.dispose()
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(agent.status).toBe('idle')
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('drains continuable subagents before disposing its own sessions', async () => {
    harness = await makeBridgeHarness()
    const order: string[] = []
    // A continuable Activation outlives the turn that started it, so the bridge
    // must release that forest before the agents whose runtime it depends on.
    harness.ctx.provide('subagents', {
      drainContinuable: () => {
        order.push('drained')
        return Promise.resolve()
      },
    } as never, true)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    harness.ctx.on('agent/disposed', () => { order.push('agent disposed') })

    await harness.acpFiber.dispose()

    expect(order).toEqual(['drained', 'agent disposed'])
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('reports a failed continuable drain and still disposes its sessions', async () => {
    harness = await makeBridgeHarness()
    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    harness.ctx.provide('subagents', {
      drainContinuable: () => Promise.reject(new Error('activation teardown failed')),
    } as never, true)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.acpFiber.dispose()

    // A stuck descendant must not strand the bridge's own teardown.
    expect(warnings.some(warning => warning.includes('continuable subagent teardown failed'))).toBe(true)
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('an ACP-only reload rejects new sessions before creating an orphan', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.acpFiber.dispose()
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/disposed/)
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('a client disconnect disposes every owned session without root-context disposal', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await vi.waitFor(() => { expect(agent.status).toBe('running') })

    await harness.closeClientTransport()
    await harness.acpFiber.dispose()
    expect(agent.status).toBe('idle')
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    expect(harness.ctx.sessions.get(SessionId(sessionId))).toBeUndefined()
  })

  it('a failed client transport still disposes every owned session', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await vi.waitFor(() => { expect(agent.status).toBe('running') })

    await harness.abortClientTransport()
    await vi.waitFor(() => {
      expect(harness!.ctx.agents.get(SessionId(sessionId)) === undefined).toBe(true)
    })
    expect(agent.status).toBe('idle')
  })

  it('disconnect and plugin disposal share one quiescence boundary', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await vi.waitFor(() => { expect(agent.status).toBe('running') })

    await Promise.all([harness.closeClientTransport(), harness.acpFiber.dispose()])
    expect(agent.status).toBe('idle')
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('disposing a session-less bridge is idempotent', async () => {
    harness = await makeBridgeHarness()
    await Promise.all([harness.acpFiber.dispose(), harness.acpFiber.dispose()])
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })
})
