/**
 * Session config options over the bridge: ONE user-facing `Permissions`
 * select (`ctx.permission`'s preset table — each choice bundles a sandbox
 * mode and an approval policy), its current value folded from each session's
 * own log, switching via `session/set_config_option` (the preset event plus
 * its knob write-throughs — the log is the store), and a resumed session
 * reporting its preset back on `session/load` with no catch-up machinery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import PermissionService from '@deepseek-ai/dsh-permission'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

/**
 * The REAL local executor reporting a confining default — `sandboxMode` is
 * the documented capability override point (`dsh-bash-sandbox` overrides it
 * the same way), so the bridge sees exactly what a sandboxing composition
 * advertises without this suite dragging in a kernel sandbox stack. It
 * reports `workspace-write`: the shipped preset's bundle, which
 * the permission service validates the composition defaults against.
 */
class SandboxedLocalExecutor extends LocalBashExecutor {
  override get sandboxMode(): SandboxMode {
    return 'workspace-write'
  }
}

/** The exact option payload the bridge advertises (pinned verbatim). */
function permissionOption(currentValue: string): object {
  return {
    id: 'permission',
    name: 'Permissions',
    description: 'The session permission preset: each choice bundles a sandbox mode and an approval policy.',
    category: 'mode',
    type: 'select',
    currentValue,
    options: [
      { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace; anything wider asks for your approval.' },
      { value: 'danger-full-access', name: 'danger-full-access', description: 'Full file access, no approval prompts.' },
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

  /** A harness composing the full preset stack (confining executor + approval seam + permission presets). */
  async function presetStack(options: { script?: NonNullable<Parameters<typeof makeBridgeHarness>[0]>['script'] } = {}): Promise<BridgeHarness> {
    const harness = await makeBridgeHarness({ storageDir, ...options.script !== undefined ? { script: options.script } : {} })
    // The dev invariants police turn-enclosure: an idle switch that appended
    // outside a turn would throw right here in the suite, not in production.
    await harness.ctx.plugin(Invariants)
    await harness.ctx.plugin(SandboxedLocalExecutor, { timeoutMs: 10_000 })
    await harness.ctx.plugin(ApprovalService)
    await harness.ctx.plugin(PermissionService)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return harness
  }

  it('advertises no configOptions without the permission service — even with both knobs composed', async () => {
    h = await makeBridgeHarness({ storageDir })
    await h.ctx.plugin(SandboxedLocalExecutor, { timeoutMs: 10_000 })
    await h.ctx.plugin(ApprovalService)
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toBeUndefined()
  })

  it('advertises the Permissions select with the default preset current', async () => {
    h = await presetStack()
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toEqual([permissionOption('workspace-write')])
  })

  it('an idle switch is pending (overlaid, not yet logged), then anchors INSIDE the next turn', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const after = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    expect(after.configOptions).toEqual([permissionOption('danger-full-access')])

    // Idle: nothing in the log yet — turn-enclosure forbids a bare append.
    const session = h.ctx.agents.list()[0]?.session
    expect(session?.events.some(e => e.type === 'permission/preset' || e.type === 'bash/sandbox-mode' || e.type === 'approval/policy')).toBe(false)

    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = session?.events ?? []
    expect(events.filter(e => e.type === 'permission/preset').map(e => e.data)).toEqual([{ preset: 'danger-full-access' }])
    expect(events.filter(e => e.type === 'bash/sandbox-mode').map(e => e.data)).toEqual([{ mode: 'danger-full-access' }])
    expect(events.filter(e => e.type === 'approval/policy').map(e => e.data)).toEqual([{ policy: 'never' }])
    const turnStart = events.findIndex(e => e.type === 'turn/start')
    const anchored = events.findIndex(e => e.type === 'permission/preset')
    expect(turnStart).toBeGreaterThanOrEqual(0)
    expect(anchored).toBeGreaterThan(turnStart)
  })

  it('an idle flip-flop anchors as ONE switch (last write wins)', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const again = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    expect(again.configOptions).toEqual([permissionOption('danger-full-access')])
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.filter(e => e.type === 'permission/preset')).toHaveLength(1)
    // Between turns (a closed turn in the log) a switch still pends — the
    // enclosure fold walks past the turn/end — and anchors with the NEXT turn.
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'workspace-write' })
    expect(h.ctx.agents.list()[0]?.session.events.filter(e => e.type === 'permission/preset')).toHaveLength(1)
  })

  it('a net-zero idle flip-flop anchors NOTHING (switches are recorded, select clicks are not)', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const back = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'workspace-write' })
    expect(back.configOptions).toEqual([permissionOption('workspace-write')])
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.some(e => e.type === 'permission/preset' || e.type === 'bash/sandbox-mode' || e.type === 'approval/policy')).toBe(false)
  })

  it('a no-op switch (the value already shown) records nothing and keeps a live pending', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const echo = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'workspace-write' })
    expect(echo.configOptions).toEqual([permissionOption('workspace-write')])
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const repeat = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    expect(repeat.configOptions).toEqual([permissionOption('danger-full-access')])
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.filter(e => e.type === 'permission/preset').map(e => e.data)).toEqual([{ preset: 'danger-full-access' }])
  })

  it('a mid-turn switch anchors immediately (the open turn encloses it)', async () => {
    h = await presetStack({ script: ['hang'] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const hung = h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    // Give the loop a tick to open the turn (the turns.spec hang idiom).
    await new Promise(resolve => setTimeout(resolve, 30))
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    const turnStart = events.findIndex(e => e.type === 'turn/start')
    const anchored = events.findIndex(e => e.type === 'permission/preset')
    expect(turnStart).toBeGreaterThanOrEqual(0)
    expect(anchored).toBeGreaterThan(turnStart)
    expect(events.some(e => e.type === 'bash/sandbox-mode')).toBe(true)
    expect(events.some(e => e.type === 'approval/policy')).toBe(true)
    await h.client.cancel({ sessionId })
    await hung
  })

  it('rejects unknown ids, unadvertised ids, boolean values, and out-of-vocabulary values', async () => {
    h = await makeBridgeHarness({ storageDir })
    await h.ctx.plugin(ApprovalService)
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'reasoning-effort', value: 'max' }))
      .rejects.toThrow(/unknown config option/)
    // `permission` exists as a concept but THIS composition never advertised it.
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' }))
      .rejects.toThrow(/unknown permission value/)
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'permission', type: 'boolean', value: true }))
      .rejects.toThrow(/select; boolean values are not accepted/)
  })

  it('rejects an out-of-vocabulary preset on an advertising composition', async () => {
    h = await presetStack()
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'plan' }))
      .rejects.toThrow(/unknown permission value/)
  })

  it('a switch in one session never leaks into a concurrent one (state and pending both per-session)', async () => {
    h = await presetStack()
    const a = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const b = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId: a.sessionId, configId: 'permission', value: 'danger-full-access' })
    // B sees the composition default, not A's pending switch...
    const bAfter = await h.client.setSessionConfigOption({ sessionId: b.sessionId, configId: 'permission', value: 'workspace-write' })
    expect(bAfter.configOptions).toEqual([permissionOption('workspace-write')])
    // ...and A keeps its own state, untouched by B's.
    const aAfter = await h.client.setSessionConfigOption({ sessionId: a.sessionId, configId: 'permission', value: 'danger-full-access' })
    expect(aAfter.configOptions).toEqual([permissionOption('danger-full-access')])
  })

  it('a knob drifted outside the table derives a visible-but-untargetable custom current', async () => {
    h = await presetStack()
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    // Drift a knob out from under the table (a plugin writing the knob
    // directly — the raw setters remain public mechanism), inside its own
    // turn: the dev invariants enforce turn-enclosure here too.
    const agent = h.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('expected an agent')
    agent.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    agent.session.append('bash/sandbox-mode', { mode: 'read-only' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // The echo of the derived current is a no-op, not an unknown-value error…
    const echo = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'custom' })
    const option = echo.configOptions?.[0]
    expect(option).toMatchObject({ currentValue: 'custom' })
    if (option === undefined || !('options' in option)) throw new Error('expected a select option')
    expect(option.options.map(o => 'value' in o ? o.value : o)).toEqual(['workspace-write', 'danger-full-access', 'custom'])
    // …while custom as a TARGET from a real preset stays rejected: switching
    // away is ordinary, and the custom entry disappears from the options.
    const away = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const afterOption = away.configOptions?.[0]
    expect(afterOption).toMatchObject({ currentValue: 'danger-full-access' })
    if (afterOption === undefined || !('options' in afterOption)) throw new Error('expected a select option')
    expect(afterOption.options.map(o => 'value' in o ? o.value : o)).toEqual(['workspace-write', 'danger-full-access'])
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'custom' }))
      .rejects.toThrow(/unknown permission value/)
  })

  it('session/load reports a resumed session\'s preset from its own log', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    // One turn checkpoints the log (the switch events flush with it).
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'persist me' }] })
    await h.dispose()
    h = undefined

    loader = await presetStack()
    const res = await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toEqual([permissionOption('danger-full-access')])
  })
})
