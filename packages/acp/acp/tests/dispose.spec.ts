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
