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
 * Exercises the default ACP composition through the real bin and Loader. The
 * keyless leg boots sandbox, approval, permission, and bridge services, then
 * initializes and opens a session without a model call or runner probe. With a
 * key and usable runner, the prompt asserts a prior denial; the model requests
 * a wider retry with justification, and a scripted client grants or rejects it.
 * The filesystem must show that only the granted retry ran. Missing credentials
 * or runner support self-skip; real denial markers remain on sandbox e2e tiers.
 */

const binScript = fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// The subprocess runs from a temp cwd outside the repo; point tsx at the repo
// tsconfig so the unbuilt `paths` map resolves (see examples/AGENTS.md).
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

// Without a usable bwrap/Seatbelt runner, the strict attempt fails closed with
// SANDBOX_UNAVAILABLE instead of producing the denial this flow requires.
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
function spawnAcpAgent(cwd: string, answer: 'allow-once' | 'reject-once'): Spawned {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, '--config', configPath],
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
      // An unexpected prompt shape cancels without granting.
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

describe('default sandbox composition keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots the tree — sandbox executor + approval service + bridge — and opens a session', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-smoke-'))
    spawned = spawnAcpAgent(workdir, 'reject-once')
    const { client } = spawned
    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION)
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    expect(sessionId.length).toBeGreaterThan(0)
  }, 30_000)

  it('advertises the Permissions select and honors a switch end to end (no key, no model)', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-config-'))
    spawned = spawnAcpAgent(workdir, 'reject-once')
    const { client } = spawned
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await client.newSession({ cwd: workdir, mcpServers: [] })
    const advertised = created.configOptions ?? []
    expect(advertised.map(option => [option.id, 'currentValue' in option ? option.currentValue : undefined]))
      .toEqual([['permission', 'workspace-write']])
    const afterFullAccess = await client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'permission', value: 'danger-full-access',
    })
    expect(afterFullAccess.configOptions?.find(option => option.id === 'permission'))
      .toMatchObject({ currentValue: 'danger-full-access' })
    const again = await client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'permission', value: 'danger-full-access',
    })
    expect((again.configOptions ?? []).map(option => [option.id, 'currentValue' in option ? option.currentValue : undefined]))
      .toEqual([['permission', 'danger-full-access']])
    await expect(client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'permission', value: 'plan',
    })).rejects.toThrow(/unknown permission value/)
  }, 30_000)
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY || !hasRunner)('default sandbox composition e2e: the live approval loop', () => {
  it('denial → model escalation → editor prompt → allow-once → the retried write lands on disk', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-e2e-'))
    spawned = spawnAcpAgent(workdir, 'allow-once')
    const { client, permissionRequests } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    const res = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: `The sandbox already denied writing ${workdir}/escalated.txt. Create it now containing exactly "ACP_ESCALATION_OK": `
        + 'one single bash call with sandbox_permissions set to danger-full-access and a one-sentence justification, then stop.' }],
    })
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)

    // Verify the filesystem, not the model's report.
    const proof = await readFile(join(workdir, 'escalated.txt'), 'utf8')
    expect(proof).toContain('ACP_ESCALATION_OK')

    // Verify that ACP carried the grant with only one-shot choices.
    expect(permissionRequests.length).toBeGreaterThan(0)
    const prompt = permissionRequests[0]
    if (prompt === undefined) throw new Error('expected a permission request')
    expect(prompt.sessionId).toBe(sessionId)
    expect(typeof prompt.toolCall.toolCallId).toBe('string')
    expect(prompt.options.map(o => o.optionId).sort()).toEqual(['allow-once', 'reject-once'])
  }, 240_000)

  it('a rejected escalation stays denied: no write lands, the turn still ends', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-e2e-'))
    spawned = spawnAcpAgent(workdir, 'reject-once')
    const { client, permissionRequests } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    const res = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: `The sandbox already denied writing ${workdir}/refused.txt. Create it now containing "NO": `
        + 'one single bash call with sandbox_permissions set to danger-full-access and a one-sentence justification. If that is rejected, stop and say so.' }],
    })
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)

    await expect(readFile(join(workdir, 'refused.txt'), 'utf8')).rejects.toThrow()
    // Distinguish a user rejection from a missing approval channel.
    expect(permissionRequests.length).toBeGreaterThan(0)
  }, 240_000)
})
