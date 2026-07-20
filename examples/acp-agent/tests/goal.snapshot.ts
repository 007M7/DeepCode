import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeSessionLog,
  normalizeStdout,
  runScenario,
  scrubRequestHeaders,
  type AgentUnderTest,
  type InputScript,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

// This lifecycle proof has goal-specific timestamp normalization and semantic
// assertions, so it owns a separate snapshot root from the generic ACP suite.
const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), 'goal-snapshots/goal-session')
const fixtureFile = join(scenarioDir, 'session.jsonl')
const overrideFile = join(scenarioDir, 'replay.override.json')
const stdoutExpected = join(scenarioDir, 'stdout.expected.jsonl')
const sessionExpected = join(scenarioDir, 'session.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

const agent: AgentUnderTest = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../goal.cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

interface JsonObject {
  [key: string]: unknown
}

/** Parse non-empty records from one JSONL artifact. */
function parseJsonl(content: string): JsonObject[] {
  return content.split('\n').filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

/** Zero durable goal timestamps inside metadata records and rendered XML JSON. */
function normalizeGoalTimestamps(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/("(?:createdAt|updatedAt|clearedAt)":)\d+/g, '$10')
  }
  if (Array.isArray(value)) return value.map(normalizeGoalTimestamps)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      ['createdAt', 'updatedAt', 'clearedAt'].includes(key) && typeof item === 'number'
        ? 0
        : normalizeGoalTimestamps(item),
    ]))
  }
  return value
}

/** Normalize one persisted goal log after the shared snapshot scrubbers. */
function normalizeGoalLog(content: string, context: NormalizeContext): string {
  return parseJsonl(scrubRequestHeaders(normalizeSessionLog(content, context)))
    .map(record => JSON.stringify(normalizeGoalTimestamps(record)))
    .join('\n') + '\n'
}

describe('ACP same-session goal snapshot', () => {
  it('runs exact automatic rounds in the shipped application and persists cancellation', async () => {
    const input = JSON.parse(await readFile(join(scenarioDir, 'input.json'), 'utf8')) as InputScript
    const result = await runScenario(input, {
      agent,
      mode: 'replay',
      fixtureFile,
      overrideFile,
      configPath: agent.configPath,
    })

    expect(result.stderr).toBe('')
    expect(result.sessionLogs).toHaveLength(1)
    const log = result.sessionLogs[0]
    if (log === undefined) throw new Error('goal snapshot did not persist its ACP session')
    const records = parseJsonl(log.content)
    const events = records.slice(1) as unknown as SessionEvent[]
    const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    expect(calls).toEqual(['create_goal', 'get_goal'])
    const rounds = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'goal'
      ? [event.data.source.round]
      : [])
    expect(rounds).toEqual([1, 2])
    expect(foldGoal(events)).toMatchObject({
      goal: {
        objective: 'Finish the ACP goal-session snapshot proof',
        phase: 'paused',
        revision: 2,
        maxGoalRounds: 2,
      },
      roundsStarted: 2,
    })

    const context: NormalizeContext = {
      sessionIds: [result.sessionId, log.id].filter((id): id is string => id !== undefined),
      cwd: result.cwd,
    }
    const stdout = normalizeStdout(result.rawStdout, context)
    const session = normalizeGoalLog(log.content, context)
    if (refreshing) {
      await Promise.all([
        writeFile(stdoutExpected, stdout),
        writeFile(sessionExpected, session),
      ])
    }
    expect(stdout).toBe(await readFile(stdoutExpected, 'utf8'))
    expect(session).toBe(await readFile(sessionExpected, 'utf8'))
  })
})
