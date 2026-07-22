import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSessionReferenceUri } from '@deepseek-ai/dsh-session-reference'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

function commandUpdates(harness: BridgeHarness, sessionId: string) {
  return harness.sessionUpdates.filter(update => update.sessionId === sessionId
    && update.update.sessionUpdate === 'available_commands_update')
}

function messageText(harness: BridgeHarness, sessionId: string): string {
  return harness.sessionUpdates
    .filter(update => update.sessionId === sessionId && update.update.sessionUpdate === 'agent_message_chunk')
    .map(({ update }) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
      ? update.content.text : '')
    .join('')
}

describe('ACP plugin commands', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-command-')) })
  afterEach(async () => {
    if (harness !== undefined) await harness.dispose()
    harness = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('publishes a full command snapshot after session creation and refreshes it dynamically', async () => {
    harness = await makeBridgeHarness({ storageDir })
    harness.ctx.commands.register({
      name: 'inspect',
      description: 'Inspect the session',
      input: { hint: '<target>' },
      handler: () => ({ kind: 'success' }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await vi.waitFor(() => {
      expect(commandUpdates(harness!, sessionId).at(-1)?.update).toEqual({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{
          name: 'inspect',
          description: 'Inspect the session',
          input: { hint: '<target>' },
        }],
      })
    })

    const dispose = harness.ctx.commands.register({
      name: 'alpha',
      description: 'Alpha command',
      handler: () => ({ kind: 'success' }),
    })
    await vi.waitFor(() => {
      expect(commandUpdates(harness!, sessionId).at(-1)?.update).toMatchObject({
        availableCommands: [{ name: 'alpha' }, { name: 'inspect' }],
      })
    })
    dispose()
    await vi.waitFor(() => {
      expect(commandUpdates(harness!, sessionId).at(-1)?.update).toMatchObject({
        availableCommands: [{ name: 'inspect' }],
      })
    })
  })

  it('re-advertises commands after loading a persisted session', async () => {
    const live = await makeBridgeHarness({ storageDir, script: [textResponse('persisted')] })
    await live.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await live.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await live.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'persist this session' }] })
    await live.dispose()

    harness = await makeBridgeHarness({ storageDir })
    harness.ctx.commands.register({
      name: 'loaded', description: 'Loaded command', handler: () => ({ kind: 'success' }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] })

    expect(commandUpdates(harness, sessionId).at(-1)?.update).toMatchObject({
      availableCommands: [{ name: 'loaded', description: 'Loaded command' }],
    })
  })

  it('coalesces registry changes before a new session command snapshot is announced', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    harness.ctx.commands.register({
      name: 'raced', description: 'Registered after the response', handler: () => ({ kind: 'success' }),
    })

    await vi.waitFor(() => {
      expect(commandUpdates(harness!, sessionId)).toHaveLength(1)
      expect(commandUpdates(harness!, sessionId)[0]?.update).toMatchObject({
        availableCommands: [{ name: 'raced' }],
      })
    })
  })

  it('executes a known single-text command directly and never sends it to the model', async () => {
    harness = await makeBridgeHarness({ storageDir })
    const seen = vi.fn(() => ({ kind: 'success' as const, text: 'DIRECT RESULT' }))
    harness.ctx.commands.register({ name: 'direct', description: 'Run directly', handler: seen })
    harness.ctx.commands.register({
      name: 'silent', description: 'Return no text', handler: () => ({ kind: 'success' }),
    })
    harness.ctx.commands.register({
      name: 'empty', description: 'Return empty text', handler: () => ({ kind: 'success', text: '' }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const response = await harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/direct  raw args ' }],
    })

    expect(response.stopReason).toBe('end_turn')
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ rawInput: '  raw args ' }))
    expect(messageText(harness, sessionId)).toContain('DIRECT RESULT')
    const updatesAfterText = harness.sessionUpdates.length
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/silent' }] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/empty' }] })
    expect(harness.sessionUpdates).toHaveLength(updatesAfterText)
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.ctx.agents.get(SessionId(sessionId))?.session.events).toHaveLength(0)
  })

  it('renders expected command errors and rejects unknown slash commands without model fallback', async () => {
    harness = await makeBridgeHarness({ storageDir })
    harness.ctx.commands.register({
      name: 'denied',
      description: 'Deny directly',
      handler: () => ({ kind: 'error', text: 'not allowed now' }),
    })
    harness.ctx.commands.register({
      name: 'throws',
      description: 'Throw an ordinary error',
      handler: () => { throw new Error('handler exploded') },
    })
    harness.ctx.commands.register({
      name: 'hostile',
      description: 'Throw a hostile value',
      handler: () => {
        throw { toString(): string { throw new Error('coercion exploded') } }
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/denied' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/missing input' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/throws' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/hostile' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })

    expect(messageText(harness, sessionId)).toContain('Error: not allowed now')
    expect(messageText(harness, sessionId)).toContain('Error: unknown command: /missing input')
    expect(messageText(harness, sessionId)).toContain('Error: command failed: Error: handler exploded')
    expect(messageText(harness, sessionId)).toContain('Error: command failed: <unrenderable thrown value>')
    expect(harness.adapter.requests).toHaveLength(0)
  })

  it('flattens supported command prompt blocks without invoking the model', async () => {
    harness = await makeBridgeHarness({ storageDir })
    const command = vi.fn(() => ({ kind: 'success' as const, text: 'combined' }))
    harness.ctx.commands.register({ name: 'direct', description: 'Direct', handler: command })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: '/direct' },
        { type: 'text', text: ' extra' },
        { type: 'resource_link', name: 'input', uri: 'file:///workspace/input.txt' },
      ],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      rawInput: ' extra\n[resource_link name="input" uri="file:///workspace/input.txt"]\n',
    }))
    expect(messageText(harness, sessionId)).toContain('combined')
    expect(harness.adapter.requests).toHaveLength(0)
  })

  it('keeps session-reference syntax opaque in direct command arguments', async () => {
    harness = await makeBridgeHarness({ storageDir })
    const command = vi.fn(() => ({ kind: 'success' as const }))
    harness.ctx.commands.register({ name: 'direct', description: 'Direct', handler: command })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const sourceUri = encodeSessionReferenceUri(SessionId('source'))

    await expect(harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: `/direct valid=${sourceUri} malformed=dsh-session:IiJ` },
        { type: 'resource_link', name: 'source', uri: sourceUri },
      ],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      rawInput: ` valid=${sourceUri} malformed=dsh-session:IiJ\n[resource_link name="source" uri=${JSON.stringify(sourceUri)}]\n`,
    }))
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.ctx.agents.get(SessionId(sessionId))?.session.events).toHaveLength(0)
  })

  it('maps session cancellation to the in-flight command signal and isolates other sessions', async () => {
    harness = await makeBridgeHarness({ storageDir })
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    harness.ctx.commands.register({
      name: 'wait',
      description: 'Wait for cancellation',
      handler: ({ signal }) => {
        started()
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => { resolve({ kind: 'error', text: 'late abort result' }) }, { once: true })
        })
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const b = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const waiting = harness.client.prompt({ sessionId: a.sessionId, prompt: [{ type: 'text', text: '/wait' }] })
    await ready
    await expect(harness.client.prompt({ sessionId: a.sessionId, prompt: [{ type: 'text', text: '/wait' }] }))
      .rejects.toThrow(/already in flight/)
    await harness.client.cancel({ sessionId: a.sessionId })

    await expect(waiting).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(harness.client.prompt({ sessionId: b.sessionId, prompt: [{ type: 'text', text: '/missing' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    expect(messageText(harness, a.sessionId)).not.toContain('late abort result')
  })

  it('aborts an in-flight command when the ACP bridge is disposed', async () => {
    harness = await makeBridgeHarness({ storageDir })
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let commandSignal: AbortSignal | undefined
    harness.ctx.commands.register({
      name: 'wait-dispose',
      description: 'Wait for bridge disposal',
      handler: ({ signal }) => {
        commandSignal = signal
        started()
        return new Promise<never>(() => {})
      },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const waiting = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/wait-dispose' }] })
    await ready
    await harness.acpFiber.dispose()

    expect(commandSignal?.aborted).toBe(true)
    await expect(waiting).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('resolves scoped command catalogs and execution independently per session', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const b = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agentA = harness.ctx.agents.get(SessionId(a.sessionId))
    if (agentA === undefined) throw new Error('session A has no agent')
    await agentA.ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'private', description: 'Only session A',
        handler: () => ({ kind: 'success', text: 'A ONLY' }),
      })
    })

    await vi.waitFor(() => {
      expect(commandUpdates(harness!, a.sessionId).at(-1)?.update).toMatchObject({ availableCommands: [{ name: 'private' }] })
    })
    expect(commandUpdates(harness, b.sessionId).at(-1)?.update).toMatchObject({ availableCommands: [] })
    await harness.client.prompt({ sessionId: a.sessionId, prompt: [{ type: 'text', text: '/private' }] })
    await harness.client.prompt({ sessionId: b.sessionId, prompt: [{ type: 'text', text: '/private' }] })
    expect(messageText(harness, a.sessionId)).toContain('A ONLY')
    expect(messageText(harness, b.sessionId)).toContain('unknown command')
  })
})
