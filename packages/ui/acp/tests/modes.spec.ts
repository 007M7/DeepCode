import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness, type CapturedUpdate } from './harness.ts'

/** The `current_mode_update` notifications, in order. */
function modeUpdates(updates: CapturedUpdate[]): string[] {
  return updates
    .filter(update => update.sessionUpdate === 'current_mode_update')
    .map(update => update.currentModeId)
}

describe('acp bridge — plan mode projection', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined
  let loader: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-modes-')) })
  afterEach(async () => {
    if (harness) await harness.dispose()
    if (loader) await loader.dispose()
    harness = loader = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('advertises no mode surface and rejects session/set_mode when plan mode is not composed', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.modes).toBeUndefined()
    await expect(harness.client.setSessionMode({ sessionId: res.sessionId, modeId: 'plan' }))
      .rejects.toMatchObject({ message: expect.stringContaining('session modes are not composed') as string })
  })

  it('advertises availableModes/currentModeId on session/new', async () => {
    harness = await makeBridgeHarness({ storageDir, withModes: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(res.modes).toEqual({
      availableModes: [
        { id: 'default', name: 'default' },
        { id: 'plan', name: 'plan' },
      ],
      currentModeId: 'default',
    })
  })

  it('session/set_mode records the pending intent and echoes one optimistic current_mode_update', async () => {
    harness = await makeBridgeHarness({ storageDir, withModes: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.setSessionMode({ sessionId, modeId: 'plan' })
    expect(modeUpdates(harness.updates)).toEqual(['plan'])
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    expect(harness.ctx.planMode.get(agent)).toEqual({ active: false, pending: true })
  })

  it('rejects an unknown ACP mode id at the adapter boundary', async () => {
    harness = await makeBridgeHarness({ storageDir, withModes: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.setSessionMode({ sessionId, modeId: 'nope' }))
      .rejects.toMatchObject({ message: expect.stringContaining('unknown session mode "nope"') as string })
    expect(modeUpdates(harness.updates)).toEqual([])
  })

  it('does not re-notify when the boundary flush logs the mode the picker already showed', async () => {
    harness = await makeBridgeHarness({ storageDir, withModes: true, script: [textResponse('planning')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.setSessionMode({ sessionId, modeId: 'plan' })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go plan' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    expect(agent.session.events.some(event => event.type === 'plan/mode')).toBe(true)
    expect(modeUpdates(harness.updates)).toEqual(['plan'])
  })

  it('re-notifies on a logged flip the picker has not seen (the tool-driven exit shape)', async () => {
    harness = await makeBridgeHarness({ storageDir, withModes: true, script: [textResponse('planning')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.setSessionMode({ sessionId, modeId: 'plan' })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go plan' }] })
    // A writer other than the picker (exit_plan_mode's execute) appends the
    // flip back; the bridge must re-notify the client off the logged event.
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('plan/mode', { active: false })
    // The notification crosses the in-memory JSON-RPC transport asynchronously.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(modeUpdates(harness.updates)).toEqual(['plan', 'default'])
  })

  it('advertises the folded mode on session/load', async () => {
    harness = await makeBridgeHarness({ storageDir, withModes: true, script: [textResponse('planning')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.setSessionMode({ sessionId, modeId: 'plan' })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go plan' }] })
    await harness.dispose()
    harness = undefined

    loader = await makeBridgeHarness({ storageDir, withModes: true, script: [] })
    await loader.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const res = await loader.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(res.modes).toEqual({
      availableModes: [
        { id: 'default', name: 'default' },
        { id: 'plan', name: 'plan' },
      ],
      currentModeId: 'plan',
    })
  })
})
