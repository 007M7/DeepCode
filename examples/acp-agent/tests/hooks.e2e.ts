import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
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
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

/**
 * With-key e2e for the Claude hook bridge. The process-level `./hooks.json` is
 * resolved from a temporary launch cwd and blocks all PreToolUse calls; a real
 * model is asked to write there, and absence of the file proves interception.
 * The test owns and disposes the ACP subprocess.
 */

const binScript = fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  updates: SessionNotification['update'][]
  stderr: string[]
}

function spawnAcpAgent(cwd: string): Spawned {
  const launch = resolveExampleLaunch({
    srcBin: binScript,
    configArgs: ['--config', configPath],
    tsconfigPath: repoTsconfig,
    env: { DSH_PERMISSION_MODE: 'danger-full-access' },
  })
  const child = spawn(
    launch.command,
    launch.args,
    { cwd, env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))

  const updates: SessionNotification['update'][] = []
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      updates.push(params.update)
      return Promise.resolve()
    },
    requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    },
  })
  const client = new ClientSideConnection(makeClient, stream)
  return { child, client, updates, stderr }
}

let spawned: Spawned | undefined
let workdir: string | undefined

afterEach(async () => {
  if (spawned) {
    spawned.child.kill('SIGKILL')
    spawned = undefined
  }
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('acp-agent e2e: a PreToolUse hook blocks bash (real model)', () => {
  it('denies every bash command, so the requested file is never written (verified on disk)', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'acp-hooks-e2e-'))
    // `configPath` is process-relative, so placing the match-all hook in the
    // launch cwd selects it; hook commands themselves run in the session cwd.
    await writeFile(join(workdir, 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo "bash blocked by policy" >&2; exit 2' }] }] },
    }))

    spawned = spawnAcpAgent(workdir)
    const { client, updates } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })

    const res = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Use the bash tool to write the exact text HOOK_FAIL into a file named proof.txt in the current directory. Then stop.' }],
    })
    // The turn completes normally (the block is a tool-result error fed back to
    // the model, not a turn failure).
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)

    // Verify that the denied hook left no filesystem effect.
    await expect(access(join(workdir, 'proof.txt'))).rejects.toThrow()

    // A blocked call is still streamed with the hook's reason as an error.
    const toolCalls = updates.filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
    expect(toolCalls.length).toBeGreaterThan(0)
  }, 180_000)
})
