import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
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
 * End-to-end: boot examples/acp-agent as a real subprocess speaking ACP over
 * its stdio, drive it with a real ClientSideConnection, send a real prompt, and
 * verify the WORLD (a file the agent wrote), not the agent's self-report. Owns
 * and disposes the subprocess in afterEach. Key-gated.
 *
 * Also asserts stdout purity (only framed JSON-RPC on stdout) — that one runs
 * WITHOUT a key, since it only needs the server to boot and answer initialize.
 */

const startScript = fileURLToPath(new URL('../start.ts', import.meta.url))
// Resolve tsx's loader to an ABSOLUTE path: the subprocess runs with cwd set to
// a temp workdir (the MVP requires session cwd === process.cwd()), where a bare
// `--import tsx` would not resolve from node_modules. import.meta.resolve gives
// the worktree's tsx regardless of the child's cwd.
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  updates: SessionNotification['update'][]
  stderr: string[]
}

function spawnAcpAgent(cwd: string): Spawned {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, startScript],
    { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] },
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
      // Permission gate is deferred (TODO(rfc010-permission-gate)); the bridge
      // never requests permission yet, so just allow if it ever does.
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

describe('acp-agent stdout purity (no key required)', () => {
  it('emits only framed JSON-RPC on stdout', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'acp-e2e-'))
    // Collect raw stdout bytes directly (bypass the SDK framing) to inspect.
    // A dummy key lets the deepseek adapter APPLY (it only checks the key is
    // present at boot, not valid — the key is used only on a real model call,
    // which this purity test never triggers). So this runs WITHOUT real creds.
    const child = spawn(process.execPath, ['--import', tsxLoader, startScript], {
      cwd: workdir,
      env: { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-dummy-for-boot' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: string[] = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => out.push(c))

    // Send a single initialize request as a newline-delimited JSON-RPC frame.
    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } })
    child.stdin.write(req + '\n')

    // Give it a moment to boot + reply, then inspect stdout.
    await new Promise(r => setTimeout(r, 4000))
    child.kill('SIGKILL')

    const lines = out.join('').split('\n').filter(l => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // Every stdout line MUST parse as JSON (a JSON-RPC frame). A non-JSON
      // line means a logger/print leaked onto the protocol channel.
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    }
  }, 30_000)
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('acp-agent e2e: real prompt over ACP', () => {
  it('runs a real turn and the agent writes the requested file (verified on disk)', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'acp-e2e-'))
    spawned = spawnAcpAgent(workdir)
    const { client, updates } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // The MVP requires cwd === the server's launch dir (its cwd is `workdir`).
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })

    const res = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Use the bash tool to write the exact text ACP_OK into a file named proof.txt in the current directory. Then stop.' }],
    })
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)

    // Verify the WORLD, not the agent's self-report: read the file from disk.
    const proof = await readFile(join(workdir, 'proof.txt'), 'utf8')
    expect(proof).toContain('ACP_OK')

    // And the client saw tool-call activity stream through.
    expect(updates.some(u => u.sessionUpdate === 'tool_call')).toBe(true)
  }, 180_000)
})
