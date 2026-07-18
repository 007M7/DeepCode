import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'

describe('desktop ACP subprocess bridge', () => {
  let storageDir: string
  let child: ChildProcessWithoutNullStreams | undefined

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-acp-'))
  })

  afterEach(async () => {
    if (child !== undefined) {
      child.stdin.end()
      child.kill('SIGTERM')
      child = undefined
    }
    await rm(storageDir, { recursive: true, force: true })
  })

  it('initializes the real ACP runtime and creates a session without a model call', async () => {
    child = spawn('node', [
      '--import',
      'tsx',
      'packages/examples/acp-demo/src/bin.ts',
      '--config',
      'examples/acp-agent/cordis.yml',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DSH_SNAPSHOT_SESSIONS_ROOT: storageDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })

    const stream: Stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const updates: SessionNotification[] = []
    const client = new ClientSideConnection((): Client => ({
      sessionUpdate(params) {
        updates.push(params)
        return Promise.resolve()
      },
      requestPermission() {
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      },
      unstable_createElicitation() {
        return Promise.resolve({ action: 'cancel' })
      },
    }), stream)

    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.agentInfo.name).toBe('deepseek-harness-acp')

    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(session.sessionId).toBeTruthy()
    expect(updates).toHaveLength(0)
    expect(stderr).not.toContain('Error:')
  }, 20_000)
})
