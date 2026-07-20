import { readFile, readdir, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeSessionLog,
  normalizeStdout,
  scrubRequestHeaders,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const snapshotsDir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const advancedScenarioDir = join(snapshotsDir, 'advanced-toolchain')
const advancedSessionFixture = join(advancedScenarioDir, 'session.jsonl')
const advancedStreamExpected = join(advancedScenarioDir, 'stream-json.expected.jsonl')
const advancedConfigPath = fileURLToPath(new URL('../advanced.cordis.snapshot.yml', import.meta.url))
const goalScenarioDir = join(snapshotsDir, 'goal-tools')
const goalConfigPath = fileURLToPath(new URL('../goal.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../packages/examples/cli-demo/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

interface JsonObject {
  [key: string]: unknown
}

interface PersistedLog {
  readonly content: string
  readonly header: JsonObject
}

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

function contextFromLogs(contents: readonly string[]): NormalizeContext {
  const headers = contents.map(content => parseJsonl(content)[0])
  return {
    sessionIds: headers.flatMap(header => typeof header?.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0no-cwd\0',
  }
}

function normalizeHeadlessStream(rawStdout: string, cwd: string): string {
  const records = parseJsonl(rawStdout)
  if (records.length === 0) throw new Error('headless snapshot emitted no stream-json records')
  const final = records.at(-1)
  if (final?.type !== 'result') throw new Error('headless snapshot did not end with a result record')
  if (records.slice(0, -1).some(record => record.type !== 'session_event')) {
    throw new Error('headless snapshot emitted a non-event record before its result')
  }

  const sessionIds = [...new Set(records.flatMap(record => typeof record.sessionId === 'string' ? [record.sessionId] : []))]
  if (sessionIds.length !== 1) throw new Error(`headless snapshot streamed ${sessionIds.length} main session ids`)
  const context: NormalizeContext = { sessionIds, cwd }
  const events = records.slice(0, -1).map((record) => {
    if (record.event === null || typeof record.event !== 'object' || Array.isArray(record.event)) {
      throw new Error('headless snapshot emitted an invalid session event')
    }
    return record.event as JsonObject
  })
  const normalizedEvents = parseJsonl(scrubRequestHeaders(normalizeSessionLog(
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    context,
  )))
  const normalizedRecords = records.map((record, index) => index < normalizedEvents.length
    ? { ...record, event: normalizedEvents[index] }
    : record)
  return normalizeStdout(`${normalizedRecords.map(record => JSON.stringify(record)).join('\n')}\n`, context)
}

/** Zero durable goal timestamps inside both metadata records and rendered XML JSON. */
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

/** Normalize the stream's durable goal timestamps after the shared scrubbers. */
function normalizeGoalStream(rawStdout: string, cwd: string): string {
  return parseJsonl(normalizeHeadlessStream(rawStdout, cwd))
    .map(record => JSON.stringify(normalizeGoalTimestamps(record)))
    .join('\n') + '\n'
}

async function scenarioPrompt(dir: string, label: string): Promise<string> {
  const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')) as {
    steps?: { op?: unknown; text?: unknown }[]
  }
  const prompt = input.steps?.find(step => step.op === 'prompt')?.text
  if (typeof prompt !== 'string') throw new Error(`${label} input has no prompt step`)
  return prompt
}

async function persistedLogs(cwd: string): Promise<PersistedLog[]> {
  const root = join(cwd, '.sessions')
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.jsonl'))
  return Promise.all(files.map(async (file) => {
    const content = await readFile(join(root, file), 'utf8')
    return { content, header: parseJsonl(content)[0] ?? {} }
  }))
}

describe('headless stream-json snapshots', () => {
  it('replays the advanced toolchain through the one-shot app', async () => {
    const prompt = await scenarioPrompt(advancedScenarioDir, 'advanced-toolchain')
    const expectedSessions = await Promise.all([
      advancedSessionFixture,
      join(advancedScenarioDir, 'session.1.jsonl'),
      join(advancedScenarioDir, 'session.2.jsonl'),
    ].map(file => readFile(file, 'utf8')))
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'advanced headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-advanced-',
      binScript,
      configPath: advancedConfigPath,
      binArgs: ['--config', advancedConfigPath, '--output-format', 'stream-json', prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: advancedSessionFixture,
        DSH_SNAPSHOT_CHILD_FILES: [
          join(advancedScenarioDir, 'session.1.jsonl'),
          join(advancedScenarioDir, 'session.2.jsonl'),
        ].join(delimiter),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(3)
        const parents = logs.filter(log => typeof log.header.parentSession !== 'string')
        expect(parents).toHaveLength(1)
        const parent = parents[0]
        if (parent === undefined) throw new Error('headless snapshot did not persist its main session')
        const children = logs.filter(log => typeof log.header.parentSession === 'string')
          .sort((left, right) => Number(left.header.createdAt) - Number(right.header.createdAt))
        const actualSessions = [parent, ...children]
        const actualContext = contextFromLogs(actualSessions.map(log => log.content))
        const expectedContext = contextFromLogs(expectedSessions)
        for (const [index, actual] of actualSessions.entries()) {
          const expected = expectedSessions[index]
          if (expected === undefined) throw new Error(`headless snapshot has no fixture for persisted log ${index}`)
          expect(scrubRequestHeaders(normalizeSessionLog(actual.content, actualContext)))
            .toBe(scrubRequestHeaders(normalizeSessionLog(expected, expectedContext)))
        }
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(advancedStreamExpected, normalized)
    expect(normalized).toBe(await readFile(advancedStreamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('replays persisted goal tools through the one-shot app', async () => {
    const prompt = await scenarioPrompt(goalScenarioDir, 'goal-tools')
    const streamExpected = join(goalScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'goal tools headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-goal-tools-',
      binScript,
      configPath: goalConfigPath,
      binArgs: ['--config', goalConfigPath, '--output-format', 'stream-json', prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: join(goalScenarioDir, 'session.jsonl'),
        DSH_SNAPSHOT_OVERRIDE: join(goalScenarioDir, 'replay.override.json'),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(1)
        const records = parseJsonl(logs[0]?.content ?? '')
        const calls = records.filter(record => record.type === 'tool/call')
          .map(record => (record.data as JsonObject | undefined)?.name)
        expect(calls).toEqual(['create_goal', 'get_goal'])
        const goalChanges = records.filter((record) => {
          if (record.type !== 'context/message') return false
          const data = record.data as JsonObject | undefined
          const meta = data?.meta as JsonObject | undefined
          return meta?.kind === 'goal/change'
        })
        expect(goalChanges).toHaveLength(1)
        const data = goalChanges[0]?.data as JsonObject | undefined
        const meta = data?.meta as JsonObject | undefined
        const goal = meta?.goal as JsonObject | undefined
        expect(meta?.operation).toBe('create')
        expect(goal).toMatchObject({
          objective: 'Finish the headless goal-tool snapshot proof',
          phase: 'active',
          maxGoalRounds: 7,
        })
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeGoalStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
