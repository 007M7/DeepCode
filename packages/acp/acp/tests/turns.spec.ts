import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  errorResponse,
  makeBridgeHarness,
  maxTokensResponse,
  textResponse,
  type BridgeHarness,
} from './harness.ts'

async function newSession(harness: BridgeHarness): Promise<string> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

function messageText(harness: BridgeHarness): string {
  return harness.updates.flatMap(update => (
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
      ? [update.content.text]
      : []
  )).join('')
}

describe('ACP prompt lifecycle', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('maps a max-token turn without losing its committed text', async () => {
    harness = await makeBridgeHarness({ script: [maxTokensResponse('cut off')] })
    const sessionId = await newSession(harness)
    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('max_tokens')
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('cut off') })
  })

  it('rejects a failed turn and never publishes its partial chunks', async () => {
    harness = await makeBridgeHarness({ script: [errorResponse('provider boom')] })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: provider boom/)
    expect(messageText(harness)).toBe('')
  })

  it('rejects an ordinary plugin failure through the same prompt boundary', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('must not run')] })
    harness.ctx.on('agent/step', () => { throw new Error('plugin pre-step failed') })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: plugin pre-step failed/)
  })

  it('settles even when an earlier turn observer throws', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    harness.ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/start' || event.type === 'turn/end') throw new Error('peer listener boom')
    }, { prepend: true })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('ignores an injection turn while correlating the owning message turn', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('real answer')] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    let injected = false
    harness.ctx.on('agent/inbox/enqueue', (subject) => {
      if (subject === agent && !injected) {
        injected = true
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'plugin', plugin: 'test' } }))
      }
    })

    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('end_turn')
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('real answer') })
  })

  it('ignores an autonomous message turn while correlating the client turn', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    let inserted = false
    harness.ctx.on('agent/inbox/enqueue', (subject, message) => {
      if (subject !== agent || message.source.kind !== 'user' || inserted) return
      inserted = true
      const source = { kind: 'plugin', plugin: 'test' } as const
      agent.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source } })
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'autonomous work' }],
        source,
      }), { surfaceOp: 'append' })
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    })

    let settled = false
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
      .finally(() => { settled = true })
    await vi.waitFor(() => {
      expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    })
    expect(settled).toBe(false)
    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('frees the prompt slot when the agent rejects the send synchronously', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const sessionId = await newSession(harness)
    // Reload the loop out from under the bridge: its agents dispose while the
    // bridge record survives, so the next send() throws synchronously.
    await harness.loopFiber.dispose()
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] }))
      .rejects.toThrow(/prompt was not queued/)
    // The failed prompt must not wedge the session's single prompt slot.
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .rejects.toThrow(/prompt was not queued/)
  })

  it('permits only one in-flight prompt per session', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .rejects.toThrow(/already in flight/)
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('cancels a running turn and records the aborted outcome', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    await vi.waitFor(() => { expect(agent.status).toBe('running') })
    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    await agent.whenIdle()
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'aborted' })
  })

  it('an idle cancel does not affect the following prompt', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    const sessionId = await newSession(harness)
    await harness.client.cancel({ sessionId })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('answer') })
  })

  it('a late end from a cancelled turn cannot settle the next prompt', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('next')] })
    const sessionId = await newSession(harness)
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('next') })
  })

  it('a retry turn adopts the prompt instead of rejecting at the failed turn end', async () => {
    harness = await makeBridgeHarness({ script: [errorResponse('transient boom'), textResponse('recovered')] })
    // A recovery policy: schedule one retry for the failed request.
    let retried = false
    harness.ctx.on('agent/request-error', async (_subject) => {
      if (!retried) {
        retried = true
        return { kind: 'retry' }
      }
    })
    const sessionId = await newSession(harness)
    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('end_turn')
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('recovered') })
  })

  it('a failed turn with no retry still rejects, at quiescence', async () => {
    harness = await makeBridgeHarness({ script: [errorResponse('terminal boom')] })
    let offered = 0
    harness.ctx.on('agent/request-error', async () => { offered += 1 })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: terminal boom/)
    expect(offered).toBe(1)
  })

  it('an admission-blocked prompt settles cancelled instead of hanging', async () => {
    harness = await makeBridgeHarness({ script: [] })
    harness.ctx.on('agent/prompt-submit', async () => ({ kind: 'block' as const, reason: 'policy said no' }))
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'cancelled' })
    // The blocked prompt opened no turn and streamed nothing.
    expect(messageText(harness)).toBe('')
  })
})
