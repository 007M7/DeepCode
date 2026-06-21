import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { makeBridgeHarness, textResponse, type BridgeHarness, type CapturedUpdate } from './harness.ts'

/** Text of the agent_message_chunk updates scoped to one session id. */
function messageTextFor(updates: { sessionId?: string; update: CapturedUpdate }[], sessionId: string): string {
  return updates
    .filter(u => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text' ? u.update.content.text : ''))
    .join('')
}

describe('acp bridge — RFC 011 multi-session isolation', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-multi-')) })
  afterEach(async () => {
    if (harness) await harness.dispose()
    harness = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('two sessions stream concurrently without interleaving their updates', async () => {
    // Each session's prompt answer must arrive only on its own sessionId. The
    // scripted adapter answers in send order; both prompts run, and the bridge
    // demuxes every chunk by session id.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('answer-A'), textResponse('answer-B')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const b = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId

    const [ra, rb] = await Promise.all([
      harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'go A' }] }),
      harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'go B' }] }),
    ])
    expect(ra.stopReason).toBe('end_turn')
    expect(rb.stopReason).toBe('end_turn')

    // A's text landed only on A; B's only on B (strict id demux, no interleave).
    expect(messageTextFor(harness.sessionUpdates, a)).toContain('answer-A')
    expect(messageTextFor(harness.sessionUpdates, a)).not.toContain('answer-B')
    expect(messageTextFor(harness.sessionUpdates, b)).toContain('answer-B')
    expect(messageTextFor(harness.sessionUpdates, b)).not.toContain('answer-A')
  })

  it('cancel in one session leaves the other session untouched', async () => {
    // Session A hangs; session B completes normally. Cancelling A settles ONLY
    // A as cancelled and never disturbs B's stream or result.
    harness = await makeBridgeHarness({ storageDir, script: ['hang', textResponse('B done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const b = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId

    const aPromise = harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'hang A' }] })
    await new Promise(r => setTimeout(r, 30))
    await harness.client.cancel({ sessionId: a })
    expect((await aPromise).stopReason).toBe('cancelled')

    // B runs to completion, unaffected by A's cancel.
    const rb = await harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'go B' }] })
    expect(rb.stopReason).toBe('end_turn')
    expect(messageTextFor(harness.sessionUpdates, b)).toContain('B done')
  })

  it('enforces one in-flight prompt PER session independently', async () => {
    harness = await makeBridgeHarness({ storageDir, script: ['hang', 'hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const b = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId

    // One in-flight prompt in EACH session is allowed (independent limits).
    const aPromise = harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'one A' }] })
    const bPromise = harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'one B' }] })
    await new Promise(r => setTimeout(r, 30))
    // A second prompt in A is rejected, but B's in-flight prompt is unaffected.
    await expect(harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'two A' }] }))
      .rejects.toThrow(/already in flight/)

    await harness.client.cancel({ sessionId: a })
    await harness.client.cancel({ sessionId: b })
    expect((await aPromise).stopReason).toBe('cancelled')
    expect((await bPromise).stopReason).toBe('cancelled')
  })

  it('a cancel for a non-existent session id is a silent no-op (does not touch others)', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('A done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    await expect(harness.client.cancel({ sessionId: 'ghost' })).resolves.toBeUndefined()
    // A still works after a cancel for an unknown id.
    const ra = await harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'go A' }] })
    expect(ra.stopReason).toBe('end_turn')
  })

  it('disposing the whole bridge drains all live sessions to quiescence', async () => {
    harness = await makeBridgeHarness({ storageDir, script: ['hang', 'hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const b = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const agentA = harness.ctx.agents.get(AgentId(a))!
    const agentB = harness.ctx.agents.get(AgentId(b))!

    // Wait deterministically for BOTH agents to enter `running` (not a fixed
    // sleep — agent startup latency is unbounded on a loaded worker).
    const running = (agent: typeof agentA) => agent.status === 'running'
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        const dispose = harness!.ctx.on('agent/status', (subject, status) => {
          if (subject === agent && status === 'running') { dispose(); resolve() }
        })
      })
    void harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'go A' }] }).catch(() => {})
    void harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'go B' }] }).catch(() => {})
    await Promise.all([running(agentA), running(agentB)])
    expect(agentA.status).toBe('running')
    expect(agentB.status).toBe('running')

    await harness.ctx.fiber.dispose()
    // BOTH agents drained (not still running) — teardown reached quiescence
    // across all sessions, not just one.
    expect(agentA.status).not.toBe('running')
    expect(agentB.status).not.toBe('running')
  })
})
