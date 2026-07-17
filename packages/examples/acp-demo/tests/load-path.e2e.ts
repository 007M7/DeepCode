import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
 * Source-path Loader smoke through the package's own bin, covering initialize, session/new, and
 * session/load across the `unwrapExports` path implicated by postmortem 0001. Session creation and
 * unknown-id loading reach factories but not the model, so a dummy key is sufficient. The temp cwd
 * is also the session workspace, and an explicit root tsconfig keeps unbuilt path aliases resolvable
 * when the child starts outside the repository.
 */

const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Repo root is four levels up from packages/examples/acp-demo/tests.
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

// A minimal leaf that loads this app + the two backends — the same shape as
// examples/acp-agent/cordis.yml, inlined so the package test owns its fixture.
const CORDIS_YML = `
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: deepseek
    model: deepseek-v4-flash
    persona: 'You are a test agent.'
    workspaceContext: false
`

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  stderr: string[]
}

let spawned: Spawned | undefined
let workdir: string | undefined

afterEach(async () => {
  if (spawned !== undefined) {
    spawned.child.kill('SIGKILL')
    spawned = undefined
  }
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function boot(): Promise<Spawned & { cwd: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'acp-agent-pkg-'))
  const cwd = workdir
  const configPath = join(cwd, 'cordis.yml')
  await writeFile(configPath, CORDIS_YML)
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, '--config', configPath],
    {
      cwd,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: repoTsconfig,
        // Key-present check only; no prompt is sent, so the model is never called.
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'keyless-acp-agent-smoke',
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(_params: SessionNotification): Promise<void> {
      return Promise.resolve()
    },
    requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    },
  })
  const client = new ClientSideConnection(makeClient, stream)
  spawned = { child, client, stderr }
  return { ...spawned, cwd }
}

describe('dsh-acp-demo real-load-path smoke (bin + Loader, keyless)', () => {
  it('boots via its bin and answers initialize → session/new → session/load', async () => {
    const { client, cwd, stderr } = await boot()
    // initialize: a broken export shape (collapsed bridge plugin, dropped inject)
    // crashes the tree on the first service read here — see postmortem 0001.
    const init = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    expect(init.agentCapabilities?.loadSession).toBe(true)

    // session/new reaches the agent FACTORY (create) without the model.
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
    expect(sessionId).toBeTruthy()

    // session/load reaches the resume FACTORY + persistence without the model: load an UNKNOWN
    // id (loading the live `sessionId` would correctly reject as "already loaded"). Persistence
    // and resume run from the JSON-RPC loop outside bridge injection; a healthy tree reaches
    // not-found, while a collapsed export would fail earlier with missing injection.
    const unknownId = '00000000-0000-4000-8000-000000000000'
    await client.loadSession({ sessionId: unknownId, cwd, mcpServers: [] }).then(
      () => { throw new Error('expected session/load of an unknown id to reject') },
      (error: unknown) => { expect(String(error)).not.toContain('without inject') },
    )

    expect(stderr.join('')).not.toContain('without inject')
  }, 30_000)
})
