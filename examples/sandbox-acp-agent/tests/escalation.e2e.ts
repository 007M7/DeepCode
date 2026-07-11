import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'

/**
 * examples/sandbox-acp-agent end to end.
 *
 * Keyless smoke: boot the REAL `cordis.yml` through the `dsh-acp-agent` bin as
 * an ACP subprocess and drive initialize + session/new — the real-Loader-path
 * guard (postmortem 0001) for THIS tree's export shapes, which now include the
 * sandbox executor AND the approval service. No prompt is sent, so neither the
 * model nor a sandbox runner is ever exercised.
 *
 * With-key escalation flow (self-skips without DEEPSEEK_API_KEY or a usable
 * platform runner): a scripted ACP client plays the human. The real model is
 * denied under `read-only`, escalates with `sandbox_permissions` +
 * `justification`, the bridge prompts THIS client over
 * `session/request_permission`, the client answers `allow-once`, and the
 * retried write must land ON DISK (world-verified). The session cwd is a temp
 * dir under the platform temp area, which `workspace-write` grants — so either
 * escalation target the model picks can land the write.
 */

const binScript = fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// The subprocess runs from a temp cwd OUTSIDE the repo; point tsx at the repo
// tsconfig so the unbuilt `paths` map resolves (see examples/AGENTS.md).
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

// A usable confining runner, probed the same way the executor suites do:
// bwrap on Linux, Seatbelt's sandbox-exec on macOS. Without one the strict
// attempt would fail closed (SANDBOX_UNAVAILABLE) instead of producing the
// denial this flow starts from.
const hasBwrap = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', 'true'], {
  timeout: 5_000,
  stdio: 'ignore',
}).status === 0
const hasSeatbelt = process.platform === 'darwin' && spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', 'true'], {
  timeout: 5_000,
  stdio: 'ignore',
}).status === 0
const hasRunner = hasBwrap || hasSeatbelt

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  updates: SessionNotification['update'][]
  permissionRequests: RequestPermissionRequest[]
  stderr: string[]
}

/** Boot the example as an ACP subprocess; the scripted client answers every permission prompt with `answer`. */
function spawnSandboxAcpAgent(cwd: string, answer: 'allow-once' | 'reject-once'): Spawned {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, configPath],
    {
      cwd,
      // A dummy key lets the deepseek adapter boot keyless (presence-checked at
      // apply, used only on a real model call); the with-key tests carry the
      // real key, so the fallback is inert there.
      env: { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-dummy-for-boot', TSX_TSCONFIG_PATH: repoTsconfig },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))

  const updates: SessionNotification['update'][] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      updates.push(params.update)
      return Promise.resolve()
    },
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      permissionRequests.push(params)
      const option = params.options.find(o => o.optionId === answer)
      // The scripted human: pick the requested option when the prompt offers
      // it; an unexpected prompt shape cancels (fail closed, never grants).
      if (option === undefined) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
    },
  })
  const client = new ClientSideConnection(makeClient, stream)
  return { child, client, updates, permissionRequests, stderr }
}

let spawned: Spawned | undefined
let workdir: string | undefined

afterEach(async () => {
  if (spawned !== undefined && spawned.child.exitCode === null) spawned.child.kill('SIGKILL')
  spawned = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe('sandbox-acp-agent keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots the tree — sandbox executor + approval service + bridge — and opens a session', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-smoke-'))
    spawned = spawnSandboxAcpAgent(workdir, 'reject-once')
    const { client } = spawned
    // A dummy key boots the adapter; no prompt is ever sent, so no model call
    // and no sandbox runner probe happen. This drives the fiber tree the same
    // way an editor would, which is what catches a broken export/inject shape.
    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION)
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    expect(sessionId.length).toBeGreaterThan(0)
  }, 30_000)

  it('advertises both session config options and honors a switch end to end (no key, no model)', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-config-'))
    spawned = spawnSandboxAcpAgent(workdir, 'reject-once')
    const { client } = spawned
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // This tree composes bash-sandbox (mode: read-only) + approval → both
    // knobs advertise, currents from composition config.
    const created = await client.newSession({ cwd: workdir, mcpServers: [] })
    const advertised = created.configOptions ?? []
    expect(advertised.map(option => [option.id, 'currentValue' in option ? option.currentValue : undefined]))
      .toEqual([['sandbox-mode', 'read-only'], ['approval-policy', 'ask']])
    // A switch responds with the COMPLETE refreshed state (the spec contract),
    // and the new currents survive in the response of a second switch.
    const afterSandbox = await client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'sandbox-mode', value: 'workspace-write',
    })
    const afterApproval = await client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'approval-policy', value: 'never',
    })
    const currents = (afterApproval.configOptions ?? []).map(option =>
      [option.id, 'currentValue' in option ? option.currentValue : undefined])
    expect(afterSandbox.configOptions?.find(option => option.id === 'sandbox-mode'))
      .toMatchObject({ currentValue: 'workspace-write' })
    expect(currents).toEqual([['sandbox-mode', 'workspace-write'], ['approval-policy', 'never']])
    // An out-of-vocabulary value is a protocol error, never a silent default.
    await expect(client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'sandbox-mode', value: 'yolo',
    })).rejects.toThrow(/unknown sandbox-mode value/)
  }, 30_000)
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY || !hasRunner)('sandbox-acp-agent e2e: the live approval loop', () => {
  it('denial → model escalation → editor prompt → allow-once → the retried write lands on disk', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-e2e-'))
    spawned = spawnSandboxAcpAgent(workdir, 'allow-once')
    const { client, permissionRequests } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    const res = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: `Use the bash tool to create the file ${workdir}/escalated.txt containing exactly "ACP_ESCALATION_OK". `
        + 'If the sandbox denies it, retry once with sandbox_permissions and a one-sentence justification, then stop.' }],
    })
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)

    // The WORLD: the approved escalated retry landed the write read-only denied.
    const proof = await readFile(join(workdir, 'escalated.txt'), 'utf8')
    expect(proof).toContain('ACP_ESCALATION_OK')

    // The CHANNEL: the grant came through a real session/request_permission
    // prompt attached to the escalating tool call, offering exactly the
    // one-shot options.
    expect(permissionRequests.length).toBeGreaterThan(0)
    const prompt = permissionRequests[0]
    if (prompt === undefined) throw new Error('expected a permission request')
    expect(prompt.sessionId).toBe(sessionId)
    expect(typeof prompt.toolCall.toolCallId).toBe('string')
    expect(prompt.options.map(o => o.optionId).sort()).toEqual(['allow-once', 'reject-once'])
  }, 240_000)

  it('a rejected escalation stays denied: no write lands, the turn still ends', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-e2e-'))
    spawned = spawnSandboxAcpAgent(workdir, 'reject-once')
    const { client, permissionRequests } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    const res = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: `Use the bash tool to create the file ${workdir}/refused.txt containing "NO". `
        + 'If the sandbox denies it, retry once with sandbox_permissions and a one-sentence justification. If that is rejected, stop and say so.' }],
    })
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)

    // The WORLD: rejected means the file never appeared.
    await expect(readFile(join(workdir, 'refused.txt'), 'utf8')).rejects.toThrow()
    // And the rejection really flowed through a prompt (not a missing channel).
    expect(permissionRequests.length).toBeGreaterThan(0)
  }, 240_000)
})
