/**
 * Assembled-app regression for persisted workspace-instruction resume state.
 * @module workspace-context-resume-snapshot
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { renderWorkspaceContext } from '@deepseek-ai/dsh-workspace-context'
import { describe, expect, it } from 'vitest'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'workspace-context-resume-snapshots/offline-edit')
const replayFixture = join(fixtureDir, 'replay.jsonl')
const replayOverride = join(fixtureDir, 'replay.override.json')
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const configPath = fileURLToPath(new URL('../workspace-context-resume.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../packages/examples/cli-demo/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const sessionId = SessionId('workspace-context-resume')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const oldInstruction = 'Old workspace instruction.'
const newInstruction = 'New workspace instruction after offline edit.'

async function seedVisibleBaseline(root: string, cwd: string): Promise<string> {
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
  const baseline = renderWorkspaceContext([{
    absolutePath: join(cwd, 'AGENTS.md'),
    displayPath: 'AGENTS.md',
    content: oldInstruction,
  }], { maxBytes: 65536 })
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    {
      type: 'user/message',
      seq: 1,
      time: 11,
      data: createUserMessage({ content: [{ type: 'text', text: 'Remember the workspace instruction.' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      seq: 2,
      time: 12,
      data: createUserMessage({
        content: [{ type: 'text', text: baseline.text }],
        source: {
          kind: 'workspace-instructions',
          baseline: true,
          changes: [{
            action: 'set',
            scope: '.\0AGENTS.md',
            path: 'AGENTS.md',
            digest: createHash('sha1').update(oldInstruction).digest('hex'),
          }],
        },
      }),
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
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

describe('workspace-context resume snapshot', () => {
  it('appends an offline replacement without duplicating the visible baseline', async () => {
    let cwd = ''
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'workspace-context resume headless stream-json snapshot',
      tempDirPrefix: 'dsh-workspace-context-resume-',
      binScript,
      configPath,
      binArgs: ['--config', configPath, '--output-format', 'stream-json', 'Acknowledge the current workspace instruction.'],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT_FILE: replayFixture,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await mkdir(join(runCwd, '.git'), { recursive: true })
        await writeFile(join(runCwd, 'AGENTS.md'), `${newInstruction}\n`)
        sessionPath = await seedVisibleBaseline(join(runCwd, '.sessions'), runCwd)
      },
      inspect: async () => {
        const normalization: NormalizeContext = { sessionIds: [sessionId], cwd }
        const session = scrubRequestHeaders(normalizeSessionLog(await readFile(sessionPath, 'utf8'), normalization))
        if (refreshing) await writeFile(sessionExpected, session)
        expect(session).toBe(await readFile(sessionExpected, 'utf8'))

        const records = session.trimEnd().split('\n').map(line => JSON.parse(line) as {
          type?: string
          data?: {
            source?: { kind?: string; baseline?: boolean; changes?: Array<Record<string, unknown>> }
            content?: Array<{ type?: string; text?: string }>
          }
        })
        const workspaceEvents = records.filter(record => record.type === 'user/message'
          && record.data?.source?.kind === 'workspace-instructions')
        expect(workspaceEvents.filter(record => record.data?.source?.baseline === true)).toHaveLength(1)
        expect(workspaceEvents.filter(record => record.data?.source?.baseline !== true)).toHaveLength(1)
        expect(workspaceEvents.at(-1)?.data?.source?.changes).toMatchObject([{
          action: 'replace', scope: '.\0AGENTS.md', path: 'AGENTS.md',
        }])
        expect(JSON.stringify(workspaceEvents.at(-1)?.data?.content)).toContain(newInstruction)

        const files = await readdir(join(cwd, '.sessions'), { recursive: true })
        expect(files.filter(file => file.endsWith('.jsonl'))).toHaveLength(1)
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      success: true,
      sessionId,
      result: 'RESUME_DONE',
      reason: { kind: 'completed' },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
