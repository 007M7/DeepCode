import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { CallId } from '@deepseek-ai/dsh-llm'
import { AgentId, type Agent } from '@deepseek-ai/dsh-agent'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

/**
 * The bridge's `approval/request` answerer: an ask for an agent the bridge
 * owns becomes a `session/request_permission` prompt attached to the tool
 * call; foreign or call-less requests delegate down to the fail-closed
 * default. Driven through `ctx.approval` — the same path dsh-tools' ask
 * routing takes — against the harness's scriptable client.
 */
describe('acp bridge — approval answerer', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-approval-')) })
  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  async function ownedAgentRequest(
    h: BridgeHarness, overrides: Partial<ApprovalRequest> = {},
  ): Promise<{ agent: Agent; request: ApprovalRequest }> {
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = h.ctx.agents.get(AgentId(sessionId))
    if (agent === undefined) throw new Error('newSession created no agent')
    // In production an ask always fires mid-turn (tool execution); open one so
    // request()'s turn-enclosure precondition holds for the direct drive below.
    agent.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    return { agent, request: { agent, toolName: 'echo', callId: CallId('call-9'), ...overrides } }
  }

  it('prompts the editor for an owned agent and maps allow-once → allowed-once', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.ctx.plugin(ApprovalService)
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    const { request } = await ownedAgentRequest(harness)
    await expect(harness.ctx.approval.request(request)).resolves.toBe('allowed-once')

    expect(harness.permissionRequests).toHaveLength(1)
    const wire = harness.permissionRequests[0]
    expect(wire?.toolCall).toEqual({ toolCallId: 'call-9' })
    expect(wire?.options.map(o => ({ optionId: o.optionId, kind: o.kind }))).toEqual([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ])
  })

  it('maps reject-once → rejected', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.ctx.plugin(ApprovalService)
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

    const { request } = await ownedAgentRequest(harness)
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
  })

  it('maps a client cancellation → cancelled', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.ctx.plugin(ApprovalService)
    harness.onPermission = () => ({ outcome: { outcome: 'cancelled' } })

    const { request } = await ownedAgentRequest(harness)
    await expect(harness.ctx.approval.request(request)).resolves.toBe('cancelled')
  })

  it('treats an unknown optionId from a non-conforming client as a rejection, never a grant', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.ctx.plugin(ApprovalService)
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-always-i-insist' } })

    const { request } = await ownedAgentRequest(harness)
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
  })

  it('delegates a foreign agent down to the fail-closed default', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.ctx.plugin(ApprovalService)
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    // Not created through the bridge: no bySession entry, so the answerer must
    // call next() — nobody else answers, so the seam fails closed.
    const foreign = { session: { events: [{ type: 'turn/start' }], append: () => ({}) } } as unknown as Agent
    await expect(harness.ctx.approval.request({ agent: foreign, toolName: 'echo', callId: CallId('c') }))
      .resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(0)
  })

  it('delegates a call-less request — the protocol prompt must attach to a tool call', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.ctx.plugin(ApprovalService)
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    const { agent } = await ownedAgentRequest(harness)
    await expect(harness.ctx.approval.request({ agent, toolName: 'echo' })).resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(0)
  })
})
