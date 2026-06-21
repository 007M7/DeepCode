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

// The dsh-acp-agent bin (the demo:acp entry) and this example's cordis.yml. The
// bin resolves its config-path arg from CWD; the subprocess runs from a temp
// workdir, so pass the example config's ABSOLUTE path.
const binScript = fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
// Resolve tsx's loader to an ABSOLUTE path: the subprocess runs with cwd set to
// a temp workdir (this test launches there and uses it as the session cwd; the
// bridge no longer requires cwd === the launch dir, but a temp dir keeps the
// test hermetic), where a bare `--import tsx` would not resolve from
// node_modules. import.meta.resolve gives the worktree's tsx regardless of cwd.
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Absolute path to the repo-root tsconfig. Dev/test/demo run UNBUILT: the
// `@deepseek-ai/dsh-*` workspace imports resolve through the `paths` map in the
// root tsconfig (tsx reads it), NOT through built `lib/` output. But tsx finds
// that tsconfig by searching UP from the child's cwd — and the child's cwd is a
// temp workdir OUTSIDE the repo, so the search misses and the dsh-* imports fail
// (the child dies before writing a byte). Point tsx at the repo tsconfig
// explicitly via TSX_TSCONFIG_PATH so resolution is cwd-independent. (Without
// this the suite only passed by accident when a stale built `lib/` happened to
// exist — exactly the contamination that masked the inject bug this suite now
// guards.) The repo root is four levels up from this file (examples/acp-agent/tests).
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  updates: SessionNotification['update'][]
  stderr: string[]
}

function spawnAcpAgent(cwd: string, env: NodeJS.ProcessEnv = process.env): Spawned {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, configPath],
    { cwd, env: { ...env, TSX_TSCONFIG_PATH: repoTsconfig }, stdio: ['pipe', 'pipe', 'pipe'] },
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

describe('acp-agent over real stdio (no key required)', () => {
  it('emits only framed JSON-RPC on stdout', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'acp-e2e-'))
    // Collect raw stdout bytes directly (bypass the SDK framing) to inspect.
    // A dummy key lets the deepseek adapter APPLY (it only checks the key is
    // present at boot, not valid — the key is used only on a real model call,
    // which this purity test never triggers). So this runs WITHOUT real creds.
    const child = spawn(process.execPath, ['--import', tsxLoader, binScript, configPath], {
      cwd: workdir,
      env: { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-dummy-for-boot', TSX_TSCONFIG_PATH: repoTsconfig },
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

  it('session/new succeeds over real stdio (no model call)', async () => {
    // REGRESSION GUARD (this exact RPC crashed a real Zed session with
    // "cannot get property \"agents\" without inject"): `session/new` drives the
    // full bridge → `ctx.agents.create({sessionId, meta:{cwd}})` → AgentLoop →
    // registry/persistence path, ALL of which run from the JSON-RPC read loop
    // OUTSIDE the bridge plugin's injection scope. A lazy `ctx.<service>` read
    // on that path throws and the RPC fails with an Internal error — yet the
    // call never touches the model, so this reproduces WITHOUT a key. The
    // key-gated prompt test below never caught it (it needs real creds); the
    // initialize-only purity test never caught it (initialize does not reach
    // the factory). This closes that gap: boot the real subprocess and create a
    // session, asserting the RPC RESOLVES (not rejects with an inject error).
    workdir = await mkdtemp(join(tmpdir(), 'acp-e2e-'))
    // A dummy key lets the deepseek adapter boot (it only checks presence, not
    // validity, at apply time); no model call is made, so the key is never used.
    spawned = spawnAcpAgent(workdir, { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-dummy-for-boot' })
    const { client } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
  }, 60_000)
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('acp-agent e2e: real prompt over ACP', () => {
  it('runs a real turn and the agent writes the requested file (verified on disk)', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'acp-e2e-'))
    spawned = spawnAcpAgent(workdir)
    const { client, updates } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // Any absolute cwd is honored now; use the temp `workdir` as this session's
    // workspace (the bash tool will run there) — it need not equal the launch dir.
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
    const toolCalls = updates.filter(u => u.sessionUpdate === 'tool_call')
    expect(toolCalls.length).toBeGreaterThan(0)

    // Tool-call UI quality (the tool owns its presentation): the bash tool's
    // `presentCall` sets the title to the exact command (an execute card hides
    // rawInput, so the command IS the title) — NOT the bare tool name "bash".
    // A `bash` call must therefore carry an execute kind, a non-"bash" title,
    // and a string rawInput (the command). `toolCalls` is already narrowed to
    // the `tool_call` shape by the filter above, so these fields are reachable.
    const bashCall = toolCalls.find(u => u.kind === 'execute')
    expect(bashCall).toBeDefined()
    if (bashCall === undefined) throw new Error('expected an execute tool_call')
    expect(typeof bashCall.title).toBe('string')
    expect(bashCall.title.length).toBeGreaterThan(0)
    expect(bashCall.title).not.toBe('bash') // the old, unhelpful title
    expect(typeof bashCall.rawInput).toBe('string') // the exact command
    // Capability OFF: no terminal _meta — the ```console text path renders.
    expect((bashCall as { _meta?: unknown })._meta).toBeUndefined()
  }, 180_000)

  it('with the terminal_output capability, a real bash call renders as a terminal card (content + _meta + exit)', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'acp-e2e-'))
    spawned = spawnAcpAgent(workdir)
    const { client, updates } = spawned

    // Advertise the Zed `_meta.terminal_output` capability so the bridge emits
    // the terminal card for the real bash tool.
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { _meta: { terminal_output: true } } })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })
    const res = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Use the bash tool to run: echo ACP_TERMINAL_OK. Then stop.' }],
    })
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)

    // A bash tool_call now carries a terminal content block + _meta.terminal_info
    // with the session cwd as the header; the matching update streams the output
    // on _meta.terminal_output.
    const bashCall = updates.find(u => u.sessionUpdate === 'tool_call' && u.kind === 'execute')
    if (bashCall?.sessionUpdate !== 'tool_call') throw new Error('expected an execute tool_call')
    // The content carries the description text block AND a terminal block (the
    // description renders above the card) — find the terminal block by type, not
    // by position.
    const blocks = (bashCall.content ?? []) as { type: string; terminalId?: string }[]
    const terminalBlock = blocks.find(b => b.type === 'terminal')
    expect(terminalBlock).toBeDefined()
    expect(typeof terminalBlock?.terminalId).toBe('string')
    const info = (bashCall._meta as { terminal_info?: { terminal_id: string; cwd?: string } }).terminal_info
    expect(info?.cwd).toBe(workdir)
    const updatesForTerminal = updates.filter(u => u.sessionUpdate === 'tool_call_update' && (u._meta as { terminal_output?: unknown } | undefined)?.terminal_output !== undefined)
    expect(updatesForTerminal.length).toBeGreaterThan(0)
    // The completed update also carries the parsed exit on _meta.terminal_exit.
    const exitUpdate = updates.find(u => u.sessionUpdate === 'tool_call_update' && (u._meta as { terminal_exit?: unknown } | undefined)?.terminal_exit !== undefined)
    expect(exitUpdate).toBeDefined()
  }, 180_000)
})
