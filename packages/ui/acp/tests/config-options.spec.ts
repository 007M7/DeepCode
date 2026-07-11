/**
 * Session config options over the bridge: the two per-session knobs
 * (`sandbox-mode`, `approval-policy`) advertised from composition capability,
 * their current values folded from each session's own log, switching via
 * `session/set_config_option` (one log-only event per switch — the log is the
 * store), and a resumed session reporting its overrides back on
 * `session/load` with no catch-up machinery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

/**
 * The REAL local executor reporting a confining default — `sandboxMode` is
 * the documented capability override point (`dsh-bash-sandbox` overrides it
 * the same way), so the bridge sees exactly what a sandboxing composition
 * advertises without this suite dragging in a kernel sandbox stack.
 */
class SandboxedLocalExecutor extends LocalBashExecutor {
  override get sandboxMode(): SandboxMode {
    return 'read-only'
  }
}

/** The exact option payloads the bridge advertises (pinned verbatim). */
function sandboxOption(currentValue: SandboxMode): object {
  return {
    id: 'sandbox-mode',
    name: 'Sandbox',
    description: 'The file sandbox mode bash commands in this session run under.',
    category: 'mode',
    type: 'select',
    currentValue,
    options: [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'danger-full-access', name: 'danger-full-access' },
    ],
  }
}

function approvalOption(currentValue: ApprovalPolicy): object {
  return {
    id: 'approval-policy',
    name: 'Approvals',
    description: 'ask: permission prompts reach you; never: they are rejected automatically.',
    type: 'select',
    currentValue,
    options: [
      { value: 'ask', name: 'ask' },
      { value: 'never', name: 'never' },
    ],
  }
}

describe('acp bridge — session config options', () => {
  let storageDir: string
  let h: BridgeHarness | undefined
  let loader: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-config-')) })
  afterEach(async () => {
    if (h) await h.dispose()
    if (loader) await loader.dispose()
    h = loader = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  /** A harness whose composition can honor both knobs (sandboxed executor + approval seam). */
  async function bothKnobs(options: { policy?: ApprovalPolicy; script?: NonNullable<Parameters<typeof makeBridgeHarness>[0]>['script'] } = {}): Promise<BridgeHarness> {
    const harness = await makeBridgeHarness({ storageDir, ...options.script !== undefined ? { script: options.script } : {} })
    // The dev invariants police turn-enclosure: an idle switch that appended
    // outside a turn would throw right here in the suite, not in production.
    await harness.ctx.plugin(Invariants)
    await harness.ctx.plugin(SandboxedLocalExecutor, { timeoutMs: 10_000 })
    await harness.ctx.plugin(ApprovalService, options.policy !== undefined ? { policy: options.policy } : {})
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return harness
  }

  it('advertises no configOptions in a composition with neither knob', async () => {
    h = await makeBridgeHarness({ storageDir })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toBeUndefined()
  })

  it('a non-confining executor advertises no sandbox option (nothing would honor it)', async () => {
    h = await makeBridgeHarness({ storageDir, withBash: true })
    await h.ctx.plugin(ApprovalService)
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toEqual([approvalOption('ask')])
  })

  it('advertises both knobs with capability-derived currents (config default included)', async () => {
    h = await bothKnobs({ policy: 'never' })
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toEqual([sandboxOption('read-only'), approvalOption('never')])
  })

  it('an idle switch is pending (overlaid, not yet logged), then anchors INSIDE the next turn', async () => {
    h = await bothKnobs({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const afterSandbox = await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'workspace-write' })
    expect(afterSandbox.configOptions).toEqual([sandboxOption('workspace-write'), approvalOption('ask')])
    const afterApproval = await h.client.setSessionConfigOption({ sessionId, configId: 'approval-policy', value: 'never' })
    expect(afterApproval.configOptions).toEqual([sandboxOption('workspace-write'), approvalOption('never')])

    // Idle: nothing in the log yet — turn-enclosure forbids a bare append
    // (the dev invariants in this suite would throw), so the switch lives on
    // the record until a turn opens.
    const session = h.ctx.agents.list()[0]?.session
    expect(session?.events.some(e => e.type === 'bash/sandbox-mode' || e.type === 'approval/policy')).toBe(false)

    // The next turn anchors both switches inside itself, one event per knob.
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = session?.events ?? []
    expect(events.filter(e => e.type === 'bash/sandbox-mode').map(e => e.data)).toEqual([{ mode: 'workspace-write' }])
    expect(events.filter(e => e.type === 'approval/policy').map(e => e.data)).toEqual([{ policy: 'never' }])
    const turnStart = events.findIndex(e => e.type === 'turn/start')
    const anchored = events.findIndex(e => e.type === 'bash/sandbox-mode')
    expect(turnStart).toBeGreaterThanOrEqual(0)
    expect(anchored).toBeGreaterThan(turnStart)
  })

  it('an idle flip-flop anchors as ONE event (last write per knob wins)', async () => {
    h = await bothKnobs({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'workspace-write' })
    await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'danger-full-access' })
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.filter(e => e.type === 'bash/sandbox-mode').map(e => e.data)).toEqual([{ mode: 'danger-full-access' }])
    // Idle again AFTER a completed turn (the log now ends in turn/end): a new
    // switch pends rather than appending outside the closed turn.
    const again = await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'read-only' })
    expect(again.configOptions?.find(option => option.id === 'sandbox-mode')).toMatchObject({ currentValue: 'read-only' })
    expect(events.filter(e => e.type === 'bash/sandbox-mode')).toHaveLength(1)
  })

  it('a no-op switch (the value already shown) records nothing and keeps a live pending', async () => {
    h = await bothKnobs({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    // Re-pushing the composition default (what clients that echo current
    // selections on session start do) must not mint an override event.
    const echo = await h.client.setSessionConfigOption({ sessionId, configId: 'approval-policy', value: 'ask' })
    expect(echo.configOptions?.find(option => option.id === 'approval-policy')).toMatchObject({ currentValue: 'ask' })
    // Re-sending a PENDING value keeps the pending switch alive (it is what
    // the session shows), rather than cancelling it.
    await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'workspace-write' })
    const repeat = await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'workspace-write' })
    expect(repeat.configOptions?.find(option => option.id === 'sandbox-mode')).toMatchObject({ currentValue: 'workspace-write' })
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.filter(e => e.type === 'approval/policy')).toHaveLength(0)
    expect(events.filter(e => e.type === 'bash/sandbox-mode').map(e => e.data)).toEqual([{ mode: 'workspace-write' }])
  })

  it('a net-zero idle flip-flop anchors NOTHING (switches are recorded, select clicks are not)', async () => {
    h = await bothKnobs({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'workspace-write' })
    const back = await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'read-only' })
    expect(back.configOptions?.find(option => option.id === 'sandbox-mode')).toMatchObject({ currentValue: 'read-only' })
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.filter(e => e.type === 'bash/sandbox-mode')).toHaveLength(0)
  })

  it('a mid-turn switch anchors immediately (the open turn encloses it)', async () => {
    h = await bothKnobs({ script: ['hang'] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const hung = h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    // Give the loop a tick to open the turn (the turns.spec hang idiom).
    await new Promise(resolve => setTimeout(resolve, 30))
    await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'workspace-write' })
    await h.client.setSessionConfigOption({ sessionId, configId: 'approval-policy', value: 'never' })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    const turnStart = events.findIndex(e => e.type === 'turn/start')
    const anchored = events.findIndex(e => e.type === 'bash/sandbox-mode')
    expect(turnStart).toBeGreaterThanOrEqual(0)
    expect(anchored).toBeGreaterThan(turnStart)
    expect(events.some(e => e.type === 'approval/policy')).toBe(true)
    await h.client.cancel({ sessionId })
    await hung
  })

  it('tolerates a provided approval stand-in whose config skipped the plugin schema', async () => {
    h = await makeBridgeHarness({ storageDir, script: [textResponse('ok')] })
    h.ctx.provide('approval', { config: {} } as unknown as InstanceType<typeof ApprovalService>)
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toEqual([approvalOption('ask')])
    const sessionId = res.sessionId
    // The schema-less config also shields the no-op guard ('ask' by the ?? fallback)…
    const echo = await h.client.setSessionConfigOption({ sessionId, configId: 'approval-policy', value: 'ask' })
    expect(echo.configOptions).toEqual([approvalOption('ask')])
    // …and the anchor-time comparison: a real switch under the stand-in still anchors.
    await h.client.setSessionConfigOption({ sessionId, configId: 'approval-policy', value: 'never' })
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.filter(e => e.type === 'approval/policy').map(e => e.data)).toEqual([{ policy: 'never' }])
  })

  it('rejects unknown ids, unadvertised ids, boolean values, and out-of-vocabulary values', async () => {
    h = await makeBridgeHarness({ storageDir })
    await h.ctx.plugin(ApprovalService)
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'reasoning-effort', value: 'max' }))
      .rejects.toThrow(/unknown config option/)
    // sandbox-mode exists as a concept but THIS composition never advertised it.
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'workspace-write' }))
      .rejects.toThrow(/unknown sandbox-mode value/)
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'approval-policy', type: 'boolean', value: true }))
      .rejects.toThrow(/select; boolean values are not accepted/)
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'approval-policy', value: 'always' }))
      .rejects.toThrow(/unknown approval-policy value/)
  })

  it('a switch in one session never leaks into a concurrent one (state and pending both per-session)', async () => {
    h = await bothKnobs()
    const a = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const b = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId: a.sessionId, configId: 'sandbox-mode', value: 'danger-full-access' })
    // B sees its own composition defaults, not A's pending switch...
    const bAfter = await h.client.setSessionConfigOption({ sessionId: b.sessionId, configId: 'approval-policy', value: 'never' })
    expect(bAfter.configOptions).toEqual([sandboxOption('read-only'), approvalOption('never')])
    // ...and A keeps its own state, untouched by B's.
    const aAfter = await h.client.setSessionConfigOption({ sessionId: a.sessionId, configId: 'sandbox-mode', value: 'danger-full-access' })
    expect(aAfter.configOptions).toEqual([sandboxOption('danger-full-access'), approvalOption('ask')])
  })

  it('session/load reports a resumed session\'s overrides from its own log', async () => {
    h = await bothKnobs({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'sandbox-mode', value: 'danger-full-access' })
    await h.client.setSessionConfigOption({ sessionId, configId: 'approval-policy', value: 'never' })
    // One turn checkpoints the log (the switch events flush with it).
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'persist me' }] })
    await h.dispose()
    h = undefined

    loader = await bothKnobs()
    const res = await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toEqual([sandboxOption('danger-full-access'), approvalOption('never')])
  })
})
