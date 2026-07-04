import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { AgentId } from '@deepseek-ai/dsh-agent'
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
    // e2e/integration tests own their resources (docs/testing.md): dispose even on
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
    expect(res.agentInfo).toEqual({ name: 'deepseek-harness-acp', version: '0.0.1' })
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

  it('allows multiple concurrent sessions, each with a distinct id', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const b = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(a.sessionId).toBeTruthy()
    expect(b.sessionId).toBeTruthy()
    expect(a.sessionId).not.toBe(b.sessionId)
    // Both agents are live and independently registered.
    expect(harness.ctx.agents.get(AgentId(a.sessionId))).toBeDefined()
    expect(harness.ctx.agents.get(AgentId(b.sessionId))).toBeDefined()
  })

  it('rejects a non-absolute cwd but accepts any absolute cwd (per-session workspace)', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // Relative cwd is still rejected (it becomes the session header / bash workdir).
    await expect(harness.client.newSession({ cwd: 'relative/path', mcpServers: [] }))
      .rejects.toThrow(/absolute/)
    // An absolute cwd that differs from the server launch dir is now ACCEPTED —
    // the per-session cwd is honored (routed to the bash workdir), so the server
    // no longer has to launch in the workspace.
    const res = await harness.client.newSession({ cwd: '/tmp', mcpServers: [] })
    expect(res.sessionId).toBeTruthy()
    // The session header records that cwd, so its bash tools run there.
    expect(harness.ctx.agents.get(AgentId(res.sessionId))!.session.header.cwd).toBe('/tmp')
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

  it('accepts a resource_link prompt by rendering the link into the text sent to the agent', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('ok')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'fix the bug in' },
        { type: 'resource_link', uri: 'file:///x.ts', name: 'x.ts' },
      ],
    })
    expect(result.stopReason).toBe('end_turn')
    const user = harness.ctx.agents.get(AgentId(sessionId))!.session.events.find(event => event.type === 'user/message')
    expect(JSON.stringify(user)).toContain('resource_link')
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

  it('honors systemPrompt config', async () => {
    harness = await makeBridgeHarness({
      storageDir,
      script: [textResponse('ok')],
      config: { systemPrompt: 'be terse' },
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // Create + prompt so the systemPrompt config flows through agentOptions and
    // reaches the model request.
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(harness.adapter.requests[0]?.system).toContain('be terse')
  })
})
