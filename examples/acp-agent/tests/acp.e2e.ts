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
 * Boots examples/acp-agent as an ACP subprocess. The key-gated prompt leg
 * verifies its filesystem effect; a keyless initialize leg verifies that stdout
 * contains only framed JSON-RPC. Each subprocess is disposed in `afterEach`.
 */

// The child runs from a temp cwd, so its bin and config path are absolute.
const binScript = fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
// Resolve tsx absolutely because the subprocess runs outside the repo.
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// The root tsconfig supplies unbuilt workspace `paths`; making it explicit
// avoids accidental resolution through stale built output.
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  updates: SessionNotification['update'][]
  stderr: string[]
}

// TODO(acp-test-harness): this subprocess/client boot glue is duplicated with
// hooks.e2e.ts and partly with dsh-acp-snapshot's harness. Migrate both e2e
// files onto that launcher before the TSX/env/permission-stub details drift.
function spawnAcpAgent(cwd: string, env: NodeJS.ProcessEnv = process.env): Spawned {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, '--config', configPath],
    {
      cwd,
      env: {
        ...env,
        TSX_TSCONFIG_PATH: repoTsconfig,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
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
      // This suite selects danger-full-access (approval never), so the bridge
      // never prompts here; answer cancelled if an unexpected ask arrives.
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    },
  })
  const client = new ClientSideConnection(makeClient, stream)
  return { child, client, updates, stderr }
}

let spawned: Spawned | undefined
let workdir: string | undefined

function hasStdoutLine(out: string[]): boolean {
  return out.join('').split('\n').some(line => line.trim().length > 0)
}

async function waitForStdoutLine(child: ChildProcessWithoutNullStreams, out: string[], stderr: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const pass = () => {
      cleanup()
      resolve()
    }
    const fail = (reason: string) => {
      cleanup()
      reject(new Error(`${reason}; stderr: ${stderr.join('')}`))
    }
    const onData = () => {
      if (hasStdoutLine(out)) pass()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(`ACP child exited before emitting a stdout frame (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
    }
    const onError = (error: Error) => {
      fail(`ACP child failed before emitting a stdout frame: ${error.message}`)
    }
    const timeout = setTimeout(() => {
      fail(`ACP child did not emit a stdout frame within ${timeoutMs}ms`)
    }, timeoutMs)

    child.stdout.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
    onData()
  })
}

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
    // A dummy key boots the adapter; this purity test sends no prompt and makes no model call.
    const child = spawn(process.execPath, ['--import', tsxLoader, binScript, '--config', configPath], {
      cwd: workdir,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-dummy-for-boot',
        TSX_TSCONFIG_PATH: repoTsconfig,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_HOME: join(workdir, '.dsh'),
        DSH_AGENTS_HOME: join(workdir, '.agents'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: string[] = []
    const stderr: string[] = []
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => out.push(c))
    child.stderr.on('data', (c: string) => stderr.push(c))

    // Send a single initialize request as a newline-delimited JSON-RPC frame.
    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } })
    child.stdin.write(req + '\n')

    try {
      await waitForStdoutLine(child, out, stderr, 15_000)
    } finally {
      child.kill('SIGKILL')
    }

    const lines = out.join('').split('\n').filter(l => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // Every stdout line MUST parse as JSON (a JSON-RPC frame). A non-JSON
      // line means a logger/print leaked onto the protocol channel.
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    }
  }, 30_000)

  it('session/new succeeds over real stdio (no model call)', async () => {
    // Regression guard (this exact RPC crashed a real Zed session with "cannot get property
    // \"agents\" without inject"): `session/new` drives the full bridge →
    // `ctx.agents.create({sessionId, meta:{cwd}})` → AgentLoop → registry/persistence path, ALL
    // of which run from the JSON-RPC read loop outside the bridge plugin's injection scope.
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

    // Verify the filesystem effect rather than the agent's report.
    const proof = await readFile(join(workdir, 'proof.txt'), 'utf8')
    expect(proof).toContain('ACP_OK')

    const toolCalls = updates.filter(u => u.sessionUpdate === 'tool_call')
    expect(toolCalls.length).toBeGreaterThan(0)

    // Bash execute cards hide rawInput, so `presentCall` uses the exact command
    // as the title rather than the bare tool name "bash".
    const bashCall = toolCalls.find(u => u.kind === 'execute')
    expect(bashCall).toBeDefined()
    if (bashCall === undefined) throw new Error('expected an execute tool_call')
    expect(typeof bashCall.title).toBe('string')
    expect(bashCall.title.length).toBeGreaterThan(0)
    expect(bashCall.title).not.toBe('bash')
    expect(typeof bashCall.rawInput).toBe('string')
    // Without the terminal capability, output uses the console-text path.
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
