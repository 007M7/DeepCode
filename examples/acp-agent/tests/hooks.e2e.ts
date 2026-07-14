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

/**
 * With-key e2e: the Claude Code hook bridge running against the REAL acp-agent
 * subprocess and the REAL model. The example `cordis.yml` loads `dsh-hooks-claude`
 * with a PROCESS-LEVEL `configPath` of `./hooks.json`, resolved once at load
 * against the ACP server's launch cwd (NOT per-session); this test sets that
 * launch cwd to the temp workspace and writes a `hooks.json` there with a
 * PreToolUse hook that BLOCKS every bash command, then asks the live model to
 * write a file — and verifies the WORLD (the file never appears on disk),
 * proving the hook actually intercepted execution rather than the agent merely
 * claiming it couldn't. (The hook itself then runs in the session cwd.)
 * Key-gated; owns and disposes its subprocess.
 *
 * A keyless companion lives in acp.e2e.ts (stdout purity + session/new); the
 * full hook-fires-end-to-end transcript is the keyless `hook-cc-promptsubmit-block`
 * snapshot scenario. This one closes the "green plumbing, broken product" gap:
 * only a real model deciding to call bash exercises the PreToolUse seam live.
 */

const binScript = fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  updates: SessionNotification['update'][]
  stderr: string[]
}

function spawnAcpAgent(cwd: string): Spawned {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, '--config', configPath],
    { cwd, env: { ...process.env, TSX_TSCONFIG_PATH: repoTsconfig, DSH_PERMISSION_MODE: 'danger-full-access' }, stdio: ['pipe', 'pipe', 'pipe'] },
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
    // A PreToolUse hook that blocks EVERY tool (exit 2, no matcher = match-all).
    // The session cwd is `workdir`, and the bridge resolves `./hooks.json` from
    // the process cwd (the launch dir = workdir), so this is the config it loads.
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

    // Verify the WORLD: the hook denied execution, so the file must NOT exist —
    // a keyword probe a "cheating" agent could fake in prose cannot pass this.
    await expect(access(join(workdir, 'proof.txt'))).rejects.toThrow()

    // The client still saw a tool_call stream (the model TRIED), and its result
    // carried the hook's block reason back as an error.
    const toolCalls = updates.filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
    expect(toolCalls.length).toBeGreaterThan(0)
  }, 180_000)
})
