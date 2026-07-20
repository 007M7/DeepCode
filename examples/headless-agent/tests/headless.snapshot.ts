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
const scenarioDir = join(snapshotsDir, 'advanced-toolchain')
const sessionFixture = join(scenarioDir, 'session.jsonl')
const streamExpected = join(scenarioDir, 'stream-json.expected.jsonl')
const configPath = fileURLToPath(new URL('../advanced.cordis.snapshot.yml', import.meta.url))
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

async function advancedPrompt(): Promise<string> {
  const input = JSON.parse(await readFile(join(scenarioDir, 'input.json'), 'utf8')) as {
    steps?: { op?: unknown; text?: unknown }[]
  }
  const prompt = input.steps?.find(step => step.op === 'prompt')?.text
  if (typeof prompt !== 'string') throw new Error('advanced-toolchain input has no prompt step')
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
    const prompt = await advancedPrompt()
    const expectedSessions = await Promise.all([
      sessionFixture,
      join(scenarioDir, 'session.1.jsonl'),
      join(scenarioDir, 'session.2.jsonl'),
    ].map(file => readFile(file, 'utf8')))
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'advanced headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-advanced-',
      binScript,
      configPath,
      binArgs: ['--config', configPath, '--output-format', 'stream-json', prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: sessionFixture,
        DSH_SNAPSHOT_CHILD_FILES: [join(scenarioDir, 'session.1.jsonl'), join(scenarioDir, 'session.2.jsonl')].join(delimiter),
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
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
