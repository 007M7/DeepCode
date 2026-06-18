import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

/**
 * End-to-end bridge specs over an in-memory transport: a real
 * ClientSideConnection drives the bridge's AgentSideConnection, so every
 * assertion exercises actual JSON-RPC framing and the harness event taxonomy.
 */
describe('acp bridge', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'acp-test-'))
  })

  afterEach(async () => {
    // e2e/integration tests own their resources (AGENTS.md): dispose even on
    // failure so a flaky run never leaks a context or persistence dir.
    if (harness) await harness.dispose()
    harness = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('initialize negotiates the protocol version and advertises capabilities', async () => {
    harness = await makeBridgeHarness({ storageDir })
    const res = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(res.agentCapabilities?.loadSession).toBe(true)
    expect(res.agentCapabilities?.promptCapabilities).toMatchObject({ image: false, audio: false })
    expect(res.agentInfo?.name).toBe('deepseek-harness-acp')
  })

  it('session/new creates a session and a full prompt turn streams text then settles end_turn', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('hello there')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(sessionId).toBeTruthy()

    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(res.stopReason).toBe('end_turn')

    // The streamed text arrived as agent_message_chunk updates.
    const text = harness.updates
      .filter(u => u.sessionUpdate === 'agent_message_chunk')
      .map(u => (u.content.type === 'text' ? u.content.text : ''))
      .join('')
    expect(text).toBe('hello there')
  })

  it('rejects a second session/new (single-session MVP)', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/single session/)
  })

  it('rejects a non-absolute cwd and a cwd that differs from the launch dir', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.newSession({ cwd: 'relative/path', mcpServers: [] }))
      .rejects.toThrow(/absolute/)
    await expect(harness.client.newSession({ cwd: '/some/other/dir', mcpServers: [] }))
      .rejects.toThrow(/launch directory/)
  })

  it('rejects non-empty additionalDirectories', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [], additionalDirectories: ['/x'] }))
      .rejects.toThrow(/additionalDirectories/)
  })

  it('rejects an empty prompt without hanging', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '   ' }] }))
      .rejects.toThrow(/empty prompt/)
  })

  it('rejects image content in a prompt (text-only capabilities)', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }],
    })).rejects.toThrow(/text/)
  })

  it('rejects a prompt carrying a non-text block alongside text (no silent context loss)', async () => {
    // A text + resource_link prompt must be rejected, not run text-only with the
    // resource silently dropped — that would feed the model an incomplete prompt.
    harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'fix the bug in' },
        { type: 'resource_link', uri: 'file:///x.ts', name: 'x.ts' },
      ],
    })).rejects.toThrow(/text/)
  })

  it('rejects a prompt for an unknown session', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.prompt({ sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] }))
      .rejects.toThrow(/unknown session/)
  })

  it('negotiates an unsupported protocol version down to the supported one', async () => {
    harness = await makeBridgeHarness({ storageDir })
    const res = await harness.client.initialize({ protocolVersion: 999, clientCapabilities: {} })
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('a cancel for an unknown/absent session is a silent no-op', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // No session created yet — cancel must not throw.
    await expect(harness.client.cancel({ sessionId: 'nope' })).resolves.toBeUndefined()
  })

  it('authenticate is a no-op (no auth methods advertised)', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.authenticate({ methodId: 'whatever' })).resolves.toBeDefined()
  })

  it('honors agentName/agentVersion/systemPrompt config', async () => {
    harness = await makeBridgeHarness({
      storageDir,
      script: [textResponse('ok')],
      config: { agentName: 'custom-agent', agentVersion: '9.9.9', systemPrompt: 'be terse' },
    })
    const res = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(res.agentInfo).toMatchObject({ name: 'custom-agent', version: '9.9.9' })
    // Create + prompt so the systemPrompt config flows through agentOptions and
    // reaches the model request.
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(harness.adapter.requests[0]?.system).toContain('be terse')
  })
})
