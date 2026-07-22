/**
 * Exercises the bridge's per-session Permissions option: validation, idle
 * turn anchoring, isolation, and persistence through `session/load`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import PermissionService from '@deepseek-ai/dsh-permission'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

/**
 * Advertises the real executor through the `sandboxMode` capability without
 * loading a kernel sandbox, which these bridge tests do not exercise.
 */
class SandboxedLocalExecutor extends LocalBashExecutor {
  override get sandboxMode(): SandboxMode {
    return 'workspace-write'
  }
}

async function mountInvariants(ctx: BridgeHarness['ctx']): Promise<void> {
  await ctx.plugin(InvariantService)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

function permissionOption(currentValue: string): object {
  return {
    id: 'permission',
    name: 'Permissions',
    description: 'The session permission preset: each choice bundles a sandbox mode and an approval policy.',
    category: 'mode',
    type: 'select',
    currentValue,
    options: [
      { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.' },
      { value: 'danger-full-access', name: 'danger-full-access', description: 'Full file access without approval prompts.' },
    ],
  }
}

function modelValue(provider = 'mock', model = 'mock'): string {
  return JSON.stringify([provider, model])
}

function modelOption(currentValue = modelValue()): object {
  return {
    id: 'model',
    name: 'Model',
    description: 'Sets this session\'s provider and model.',
    category: 'model',
    type: 'select',
    currentValue,
    options: [{ value: modelValue(), name: 'Mock' }],
  }
}

function optionsWithPermission(currentValue: string): object[] {
  return [modelOption(), permissionOption(currentValue)]
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

  async function presetStack(options: { script?: NonNullable<Parameters<typeof makeBridgeHarness>[0]>['script'] } = {}): Promise<BridgeHarness> {
    const harness = await makeBridgeHarness({ storageDir, ...options.script !== undefined ? { script: options.script } : {} })
    // Make an out-of-turn switch fail in this suite.
    await mountInvariants(harness.ctx)
    await harness.ctx.plugin(SandboxedLocalExecutor, { timeoutMs: 10_000 })
    await harness.ctx.plugin(ApprovalService)
    await harness.ctx.plugin(PermissionService)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return harness
  }

  it('advertises the model selector without requiring the permission service', async () => {
    h = await makeBridgeHarness({ storageDir })
    await h.ctx.plugin(SandboxedLocalExecutor, { timeoutMs: 10_000 })
    await h.ctx.plugin(ApprovalService)
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toEqual([modelOption()])
  })

  it('groups models by provider and switches routing plus prompt variables as one session target', async () => {
    h = await makeBridgeHarness({
      storageDir,
      script: [textResponse('ok')],
      config: { provider: 'alpha', model: 'a1' },
      persona: 'Route {{provider}} / {{model}}',
      catalog: {
        providers: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
        models: [
          { provider: 'alpha', id: 'a1', name: 'Alpha One', description: 'Fast' },
          { provider: 'beta', id: 'b1', name: 'Beta One' },
        ],
      },
    })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.configOptions).toEqual([{
      id: 'model',
      name: 'Model',
      description: 'Sets this session\'s provider and model.',
      category: 'model',
      type: 'select',
      currentValue: modelValue('alpha', 'a1'),
      options: [
        { group: 'alpha', name: 'Alpha', options: [{ value: modelValue('alpha', 'a1'), name: 'Alpha One', description: 'Fast' }] },
        { group: 'beta', name: 'Beta', options: [{ value: modelValue('beta', 'b1'), name: 'Beta One' }] },
      ],
    }])

    const switched = await h.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: modelValue('beta', 'b1'),
    })
    expect(switched.configOptions?.[0]).toMatchObject({ currentValue: modelValue('beta', 'b1') })
    await h.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'use beta' }] })
    expect(h.adapter.requests[0]).toMatchObject({
      provider: 'beta',
      model: 'b1',
    })
    expect(h.adapter.requests[0]?.system).toContain('Route beta / b1')
    expect(h.ctx.agents.list()[0]?.session.requestHeader()?.config).toMatchObject({ provider: 'beta', model: 'b1' })
  })

  it('adds the configured private model to an advisory catalog and ignores empty non-current groups', async () => {
    h = await makeBridgeHarness({
      storageDir,
      config: { provider: 'alpha', model: 'private-model' },
      catalog: {
        providers: [{ id: 'alpha', name: 'Alpha' }, { id: 'empty', name: 'Empty' }],
        models: [{ provider: 'alpha', id: 'public-model', name: 'Public Model' }],
      },
    })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions?.[0]).toMatchObject({
      currentValue: modelValue('alpha', 'private-model'),
      options: [
        { value: modelValue('alpha', 'public-model'), name: 'Public Model' },
        { value: modelValue('alpha', 'private-model'), name: 'private-model' },
      ],
    })
  })

  it('omits model selection without a complete or registered current target', async () => {
    h = await makeBridgeHarness({ storageDir, config: { model: undefined } })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const missing = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(missing.configOptions).toBeUndefined()
    await h.dispose()

    h = await makeBridgeHarness({ storageDir, config: { provider: 'unregistered', model: 'm' } })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const unknown = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(unknown.configOptions).toBeUndefined()
  })

  it('leaves model-less agents available to another agent/request supplier', async () => {
    h = await makeBridgeHarness({ storageDir, config: { model: undefined }, script: [textResponse('ok')] })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = h.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('expected an agent')
    agent.ctx.on('agent/request', async (_agent, _turn, _step, callConfig, _signal, _next) => ({
      ...callConfig,
      provider: 'mock',
      model: 'mock',
    }))
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'supplied elsewhere' }] })
    expect(h.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'mock' })
  })

  it('advertises the Permissions select with the default preset current', async () => {
    h = await presetStack()
    const res = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.configOptions).toEqual(optionsWithPermission('workspace-write'))
  })

  it('an idle switch is pending (overlaid, not yet logged), then anchors inside the next prompt\'s turn', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const after = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    expect(after.configOptions).toEqual(optionsWithPermission('danger-full-access'))

    const session = h.ctx.agents.list()[0]?.session
    expect(session?.events.some(e => e.type === 'permission/preset' || e.type === 'sandbox/mode' || e.type === 'approval/policy')).toBe(false)

    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = session?.events ?? []
    expect(events.filter(e => e.type === 'permission/preset').map(e => e.data)).toEqual([{ preset: 'danger-full-access' }])
    expect(events.filter(e => e.type === 'sandbox/mode').map(e => e.data)).toEqual([{ mode: 'danger-full-access' }])
    expect(events.filter(e => e.type === 'approval/policy').map(e => e.data)).toEqual([{ policy: 'never' }])
    const turnStart = events.findIndex(e => e.type === 'turn/start')
    const anchored = events.findIndex(e => e.type === 'permission/preset')
    expect(turnStart).toBeGreaterThanOrEqual(0)
    expect(anchored).toBeGreaterThan(turnStart)
  })

  it('an idle flip-flop anchors as one switch (last write wins)', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const again = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    expect(again.configOptions).toEqual(optionsWithPermission('danger-full-access'))
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.filter(e => e.type === 'permission/preset')).toHaveLength(1)
    // A closed turn does not make a later idle switch appendable.
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'workspace-write' })
    expect(h.ctx.agents.list()[0]?.session.events.filter(e => e.type === 'permission/preset')).toHaveLength(1)
  })

  it('a net-zero idle flip-flop anchors nothing (switches are recorded, select clicks are not)', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const back = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'workspace-write' })
    expect(back.configOptions).toEqual(optionsWithPermission('workspace-write'))
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'anchor' }] })
    const events = h.ctx.agents.list()[0]?.session.events ?? []
    expect(events.some(e => e.type === 'permission/preset' || e.type === 'sandbox/mode' || e.type === 'approval/policy')).toBe(false)
  })

  it('a no-op switch (the value already shown) records nothing and keeps a live pending', async () => {
    h = await presetStack({ script: [textResponse('ok')] })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const echo = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'workspace-write' })
    expect(echo.configOptions).toEqual(optionsWithPermission('workspace-write'))
    await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const repeat = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    expect(repeat.configOptions).toEqual(optionsWithPermission('danger-full-access'))
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
    expect(events.some(e => e.type === 'sandbox/mode')).toBe(true)
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
    // This composition never advertised `permission`.
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' }))
      .rejects.toThrow(/unknown permission value/)
    await expect(h.client.setSessionConfigOption({ sessionId, configId: 'model', value: modelValue('mock', 'missing') }))
      .rejects.toThrow(/unknown model value/)
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
    const bAfter = await h.client.setSessionConfigOption({ sessionId: b.sessionId, configId: 'permission', value: 'workspace-write' })
    expect(bAfter.configOptions).toEqual(optionsWithPermission('workspace-write'))
    const aAfter = await h.client.setSessionConfigOption({ sessionId: a.sessionId, configId: 'permission', value: 'danger-full-access' })
    expect(aAfter.configOptions).toEqual(optionsWithPermission('danger-full-access'))
  })

  it('keeps model targets isolated across concurrent sessions', async () => {
    h = await makeBridgeHarness({
      storageDir,
      script: [textResponse('a'), textResponse('b')],
      config: { provider: 'mock', model: 'one' },
      catalog: {
        providers: [{ id: 'mock', name: 'Mock' }],
        models: [
          { provider: 'mock', id: 'one', name: 'One' },
          { provider: 'mock', id: 'two', name: 'Two' },
        ],
      },
    })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const b = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId: a.sessionId, configId: 'model', value: modelValue('mock', 'two') })
    await h.client.prompt({ sessionId: a.sessionId, prompt: [{ type: 'text', text: 'a' }] })
    await h.client.prompt({ sessionId: b.sessionId, prompt: [{ type: 'text', text: 'b' }] })
    expect(h.adapter.requests.map(request => request.model)).toEqual(['two', 'one'])
  })

  it('a knob drifted outside the table derives a visible-but-untargetable custom current', async () => {
    h = await presetStack()
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    // Simulate a plugin calling the public knob setter inside a valid turn.
    const agent = h.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('expected an agent')
    agent.session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    agent.session.append('sandbox/mode', { mode: 'read-only' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const echo = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'custom' })
    const option = echo.configOptions?.find(entry => entry.id === 'permission')
    expect(option).toMatchObject({ currentValue: 'custom' })
    if (option === undefined || !('options' in option)) throw new Error('expected a select option')
    expect(option.options.map(o => 'value' in o ? o.value : o)).toEqual(['workspace-write', 'danger-full-access', 'custom'])
    const away = await h.client.setSessionConfigOption({ sessionId, configId: 'permission', value: 'danger-full-access' })
    const afterOption = away.configOptions?.find(entry => entry.id === 'permission')
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
    expect(res.configOptions).toEqual(optionsWithPermission('danger-full-access'))
  })

  it('session/load restores the last requested provider/model from the request header', async () => {
    const catalog = {
      providers: [{ id: 'mock', name: 'Mock' }],
      models: [
        { provider: 'mock', id: 'one', name: 'One' },
        { provider: 'mock', id: 'two', name: 'Two' },
      ],
    }
    h = await makeBridgeHarness({
      storageDir,
      script: [textResponse('ok')],
      config: { provider: 'mock', model: 'one' },
      catalog,
    })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.setSessionConfigOption({ sessionId, configId: 'model', value: modelValue('mock', 'two') })
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'persist target' }] })
    await h.dispose()
    h = undefined

    loader = await makeBridgeHarness({ storageDir, config: { provider: 'mock', model: 'one' }, catalog })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const loaded = await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(loaded.configOptions?.find(option => option.id === 'model')).toMatchObject({
      currentValue: modelValue('mock', 'two'),
    })
  })

  it('session/load omits config options when the persisted session has no target or permission service', async () => {
    h = await makeBridgeHarness({ storageDir, config: { model: undefined } })
    await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = h.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('expected an agent')
    agent.inject([{ type: 'text', text: 'checkpoint' }], { source: { kind: 'plugin', plugin: 'test' } })
    await agent.whenIdle()
    await h.dispose()
    h = undefined

    loader = await makeBridgeHarness({ storageDir, config: { model: undefined } })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const loaded = await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(loaded.configOptions).toBeUndefined()
  })
})
