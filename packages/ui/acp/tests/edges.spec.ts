import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('acp bridge — demux & config edges', () => {
  let storageDir: string
  let harness: BridgeHarness | undefined

  beforeEach(async () => { storageDir = await mkdtemp(join(tmpdir(), 'acp-edge-')) })
  afterEach(async () => {
    if (harness) await harness.dispose()
    harness = undefined
    await rm(storageDir, { recursive: true, force: true })
  })

  it('ignores events from an agent the bridge does not own (strict id demux)', async () => {
    // A second agent created directly on the registry (NOT via the bridge) runs
    // a turn. Its session/event + agent/status must NOT produce ACP updates and
    // must not settle anything — the bridge demuxes strictly by its own id.
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('foreign')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const before = harness.updates.length

    const { agent: foreign } = harness.ctx.agents.create({ agentId: 'foreign', sessionId: 'foreign-session', agentOptions: { model: 'mock' } })
    foreign.send([{ type: 'text', text: 'hi' }])
    await foreign.whenIdle()
    await new Promise(r => setTimeout(r, 10))

    // No update was emitted for the foreign agent's stream.
    expect(harness.updates.length).toBe(before)
  })

  it('survives a session/update that the client rejects (best-effort notify)', async () => {
    harness = await makeBridgeHarness({ storageDir, script: [textResponse('ok')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    // Make the client reject every update — the bridge's notify() must swallow
    // the rejection and the prompt must still settle normally.
    harness.onSessionUpdateError = () => { throw new Error('client update rejected') }
    const res = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(res.stopReason).toBe('end_turn')
  })

  it('accepts session/new with additionalDirectories empty', async () => {
    // Exercises the defined-but-empty additionalDirectories branch (length 0 → allowed).
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [], additionalDirectories: [] })
    expect(a.sessionId).toBeTruthy()
  })

  it('rejects non-empty mcpServers until MCP wiring is implemented', async () => {
    harness = await makeBridgeHarness({ storageDir })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'fs', command: 'npx', args: ['server'], env: [] }],
    })).rejects.toThrow(/mcpServers/)
  })
})
