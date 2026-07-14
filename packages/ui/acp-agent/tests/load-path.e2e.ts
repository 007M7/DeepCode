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
 * REAL-load-path smoke for @deepseek-ai/dsh-acp-agent: boot the app through its
 * own `bin` (the demo:acp entry) as a subprocess, driving the cordis Loader and
 * `unwrapExports` over a minimal `cordis.yml` that loads THIS package. This is
 * the guard a hand-built `ctx.plugin({...})` mount structurally cannot be — that
 * bypasses `unwrapExports`, the exact path that once dropped the bridge's
 * `inject` and shipped (docs/postmortem/0001). It exercises the headline ACP
 * operations end-to-end: `initialize` → `session/new` → `session/load`.
 *
 * KEYLESS: `session/new` and `session/load` reach the agent FACTORY but never
 * the model (no prompt is sent), so no DEEPSEEK_API_KEY is needed. A dummy key
 * lets `llm-deepseek`'s `apply()` (key-PRESENT check only) boot the tree.
 *
 * The config is written into a temp dir whose cwd IS the session workspace, so
 * the bash workdir validation passes. We point tsx at the repo-root tsconfig
 * (TSX_TSCONFIG_PATH) because the child's cwd is outside the repo and the
 * unbuilt `paths` map is found by searching UP from cwd.
 */

const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Repo root is four levels up from packages/ui/acp-agent/tests.
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

// A minimal leaf that loads this app + the two backends — the same shape as
// examples/acp-agent/cordis.yml, inlined so the package test owns its fixture.
const CORDIS_YML = `
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
    models: [deepseek-v4-flash]
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-agent'
  config:
    model: deepseek-v4-flash
    persona: 'You are a test agent.'
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

describe('dsh-acp-agent real-load-path smoke (bin + Loader, keyless)', () => {
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

    // session/load reaches the resume FACTORY + persistence without the model:
    // load an UNKNOWN id (loading the live `sessionId` would correctly reject as
    // "already loaded"). The bridge consults `sessionPersistence.list()` then
    // `agents.resume()`, both of which run from the JSON-RPC read loop OUTSIDE
    // the bridge's inject scope — the exact path postmortem 0001 crashed. A
    // healthy tree rejects with a not-found error; a broken export shape would
    // instead throw "cannot get property … without inject" before reaching it.
    const unknownId = '00000000-0000-4000-8000-000000000000'
    await client.loadSession({ sessionId: unknownId, cwd, mcpServers: [] }).then(
      () => { throw new Error('expected session/load of an unknown id to reject') },
      (error: unknown) => { expect(String(error)).not.toContain('without inject') },
    )

    expect(stderr.join('')).not.toContain('without inject')
  }, 30_000)
})
