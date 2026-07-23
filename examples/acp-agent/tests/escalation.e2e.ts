import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
} from '@agentclientprotocol/sdk'
import {
  launchAcpTestAgent,
  type AgentUnderTest,
  type LaunchedAcpTestAgent,
} from '@deepseek-ai/dsh-acp-snapshot'
import { cleanupAcpExampleTest } from './cleanup.ts'

/**
 * The default ACP composition (`cordis.yml`) end to end.
 *
 * Keyless smoke: boot the REAL `cordis.yml` through the `dsh-acp-agent` bin as
 * an ACP subprocess and drive initialize + session/new — the real-Loader-path
 * guard (postmortem 0001) for THIS tree's export shapes, which now include the
 * sandbox executor AND the approval service. No prompt is sent, so neither the
 * model nor a sandbox runner is ever exercised.
 *
 * With-key escalation flow (self-skips without DEEPSEEK_API_KEY or a usable
 * platform runner): a scripted ACP client plays the human. The subprocess
 * starts read-only, its first real bash write is denied, the model retries with
 * `sandbox_permissions` + `justification`, and the bridge prompts THIS client
 * over `session/request_permission`. An approved workspace-write retry must
 * then land ON DISK (world-verified).
 */

const AGENT: AgentUnderTest = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

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

interface Spawned extends LaunchedAcpTestAgent {
  permissionRequests: RequestPermissionRequest[]
}

/** Boot the example with an optional sandbox override; the scripted client answers every permission prompt with `answer`. */
function launchExampleAcpAgent(
  cwd: string,
  answer: 'allow-once' | 'reject-once',
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
): Spawned {
  const permissionRequests: RequestPermissionRequest[] = []
  const launched = launchAcpTestAgent({
    agent: AGENT,
    cwd,
    // A dummy key lets the adapter boot keylessly; live tests carry the real key.
    env: {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-dummy-for-boot',
      DSH_PERMISSION_MODE: sandboxMode,
    },
    requestPermission(params) {
      permissionRequests.push(params)
      const option = params.options.find(o => o.optionId === answer)
      // The scripted human: pick the requested option when the prompt offers
      // it; an unexpected prompt shape cancels (fail closed, never grants).
      if (option === undefined) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
    },
  })
  return Object.assign(launched, { permissionRequests })
}

function escalationPrompt(path: string, content: string): string {
  return `Create ${path} containing exactly ${JSON.stringify(content)} using bash, not filesystem tools. `
    + 'First try the command without sandbox_permissions. If the sandbox denies it, retry that exact command once '
    + 'with sandbox_permissions set to workspace-write and a one-sentence justification.'
}

function includesReadOnlyDenial(updates: LaunchedAcpTestAgent['updates']): boolean {
  return updates.some(update => update.sessionUpdate === 'tool_call_update'
    && JSON.stringify(update.content).includes('[sandbox: file access denied under read-only mode]'))
}

let spawned: Spawned | undefined
let workdir: string | undefined

afterEach(async () => {
  const ownedSpawned = spawned
  const ownedWorkdir = workdir
  spawned = undefined
  workdir = undefined
  await cleanupAcpExampleTest(ownedSpawned, ownedWorkdir)
})

describe('default sandbox composition keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots the tree — sandbox executor + approval service + bridge — and opens a session', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-smoke-'))
    spawned = launchExampleAcpAgent(workdir, 'reject-once')
    const { client } = spawned
    // A dummy key boots the adapter; no prompt is ever sent, so no model call
    // and no sandbox runner probe happen. This drives the fiber tree the same
    // way an editor would, which is what catches a broken export/inject shape.
    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION)
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    expect(sessionId.length).toBeGreaterThan(0)
  }, 30_000)

  it('advertises model and Permissions selects and honors a permission switch without a model call', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-config-'))
    spawned = launchExampleAcpAgent(workdir, 'reject-once')
    const { client } = spawned
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // This tree composes the permission presets over bash-sandbox + approval →
    // ONE select advertises, current from the configured default preset.
    const created = await client.newSession({ cwd: workdir, mcpServers: [] })
    const advertised = created.configOptions ?? []
    const modelValue = JSON.stringify(['deepseek', 'deepseek-v4-pro'])
    expect(advertised.map(option => [option.id, 'currentValue' in option ? option.currentValue : undefined]))
      .toEqual([['model', modelValue], ['permission', 'workspace-write']])
    // A switch responds with the COMPLETE refreshed state (the spec contract),
    // and the new current survives in the response of a second switch.
    const afterFullAccess = await client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'permission', value: 'danger-full-access',
    })
    expect(afterFullAccess.configOptions?.find(option => option.id === 'permission'))
      .toMatchObject({ currentValue: 'danger-full-access' })
    const again = await client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'permission', value: 'danger-full-access',
    })
    expect((again.configOptions ?? []).map(option => [option.id, 'currentValue' in option ? option.currentValue : undefined]))
      .toEqual([['model', modelValue], ['permission', 'danger-full-access']])
    // An out-of-vocabulary value is a protocol error, never a silent default.
    await expect(client.setSessionConfigOption({
      sessionId: created.sessionId, configId: 'permission', value: 'plan',
    })).rejects.toThrow(/unknown permission value/)
  }, 30_000)
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY || !hasRunner)('default sandbox composition e2e: the live approval loop', () => {
  it('denial → model escalation → editor prompt → allow-once → the retried write lands on disk', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'sandbox-acp-e2e-'))
    spawned = launchExampleAcpAgent(workdir, 'allow-once', 'read-only')
    const { client, permissionRequests, updates } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    const res = await client.prompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: `${escalationPrompt(join(workdir, 'escalated.txt'), 'ACP_ESCALATION_OK')} Then stop.`,
      }],
    })
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)
    expect(includesReadOnlyDenial(updates)).toBe(true)

    // The WORLD: the approved escalated retry landed the write.
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
    spawned = launchExampleAcpAgent(workdir, 'reject-once', 'read-only')
    const { client, permissionRequests, updates } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    const res = await client.prompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: `${escalationPrompt(join(workdir, 'refused.txt'), 'NO')} If approval is rejected, stop and say so.`,
      }],
    })
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)
    expect(includesReadOnlyDenial(updates)).toBe(true)

    // The WORLD: rejected means the file never appeared.
    await expect(readFile(join(workdir, 'refused.txt'), 'utf8')).rejects.toThrow()
    // And the rejection really flowed through a prompt (not a missing channel).
    expect(permissionRequests.length).toBeGreaterThan(0)
  }, 240_000)
})
