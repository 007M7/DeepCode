import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import {
  launchAcpTestAgent,
  normalizeSessionLog,
  normalizeStdout,
  scrubRequestHeaders,
  type AgentUnderTest,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it } from 'vitest'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'semantic-checkpoint-snapshots/tool-outcome-unknown')
const replayFixture = join(fixtureDir, 'replay.jsonl')
const replayOverride = join(fixtureDir, 'replay.override.json')
const stdoutExpected = join(fixtureDir, 'stdout.expected.jsonl')
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const sessionId = SessionId('semantic-checkpoint-unknown-outcome')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

const agent: AgentUnderTest = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

async function seedInterruptedSession(root: string, cwd: string): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd,
    delegationDepth: 0,
  }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'user/message', seq: 1, time: 11, data: { content: [{ type: 'text', text: 'Perform one side-effecting remote mutation.' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: 12, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 13,
      data: {
        turn: 1,
        step: 1,
        content: [{ type: 'tool-call', id: CallId('unknown-outcome-call'), name: 'write_remote', arguments: '{"value":1}' }],
        provenance: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: 4,
      time: 14,
      data: {
        turn: 1,
        step: 1,
        callId: CallId('unknown-outcome-call'),
        name: 'write_remote',
        arguments: '{"value":1}',
      },
    },
  ]
  try {
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(sessionId, events)
    const location = ctx.sessionPersistence.locate(meta)
    if (location === undefined) throw new Error('JSONL backend did not locate the seeded session')
    return location.path
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('semantic checkpoint recovery snapshot', () => {
  it('loads an unknown tool outcome and carries retry-risk guidance into the next model turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-semantic-snapshot-cwd-'))
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'dsh-semantic-snapshot-sessions-'))
    let launched: ReturnType<typeof launchAcpTestAgent> | undefined
    try {
      const sessionPath = await seedInterruptedSession(sessionsRoot, cwd)
      launched = launchAcpTestAgent({
        agent,
        cwd,
        env: {
          DSH_SNAPSHOT: 'replay',
          DSH_SNAPSHOT_FILE: replayFixture,
          DSH_SNAPSHOT_OVERRIDE: replayOverride,
          DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
        },
      })
      await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      await launched.client.loadSession({ sessionId, cwd, mcpServers: [] })
      await launched.client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'Continue safely from the interrupted operation.' }],
      })
      await launched.close()

      const normalization: NormalizeContext = { sessionIds: [sessionId], cwd }
      const stdout = normalizeStdout(launched.rawStdout(), normalization)
      const session = scrubRequestHeaders(normalizeSessionLog(await readFile(sessionPath, 'utf8'), normalization))
      if (refreshing) {
        await writeFile(stdoutExpected, stdout)
        await writeFile(sessionExpected, session)
      }
      expect(stdout).toBe(await readFile(stdoutExpected, 'utf8'))
      expect(session).toBe(await readFile(sessionExpected, 'utf8'))
      expect(session).toContain('TOOL_OUTCOME_UNKNOWN')
      expect(session).toContain('Do not retry blindly.')
    } finally {
      await launched?.close('SIGKILL').catch(() => undefined)
      await Promise.all([
        rm(cwd, { recursive: true, force: true }),
        rm(sessionsRoot, { recursive: true, force: true }),
      ])
    }
  })
})
