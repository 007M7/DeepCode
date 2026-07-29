/**
 * Keyless snapshot coverage for the TypeScript SDK path: each scenario spawns
 * the REAL `dsh-jsonrpc-agent` runtime (per `DSH_EXAMPLE_MODE`) through the
 * REAL `@deepseek-ai/dsh-sdk-client`, drives one turn over stdio JSON-RPC,
 * and pins three surfaces — the SDK `TurnResult`, the complete notification
 * stream, and the persisted session logs. Replay serves recorded model
 * responses via `llm-replay` (`cordis.snapshot.yml`); `DSH_SNAPSHOT=record`
 * re-records against the live API; `DSH_SNAPSHOT=refresh` replays committed
 * fixtures and rewrites expected outputs.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  normalizeSessionLog,
  normalizeStdout,
  refreshFixtureReplacements,
  scrubRequestHeaders,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
  type HarvestedLog,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { DeepSeekHarness, type HarnessNotification, type TurnResult } from '@deepseek-ai/dsh-sdk-client'

const testsDir = dirOf(import.meta.url)
const snapshotsDir = join(testsDir, 'snapshots')
const liveConfig = join(testsDir, '..', 'cordis.yml')
const replayConfig = join(testsDir, '..', 'cordis.snapshot.yml')
const runtimeBin = fileURLToPath(new URL('../../../packages/examples/jsonrpc-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

const mode = process.env.DSH_SNAPSHOT ?? 'replay'
const recording = mode === 'record'
const refreshing = mode === 'refresh'

function dirOf(url: string): string {
  return fileURLToPath(new URL('.', url))
}

interface SdkScenario {
  /** Scenario name; the snapshots/<name> fixture directory. */
  name: string
  /** The user prompt for the single SDK turn. */
  prompt: string
  /** Fixed SDK session id, so fixtures and replay binding stay stable. */
  sessionId: string
  /** How many child sessions the turn persists (subagent scenarios). */
  children: number
}

const SCENARIOS: SdkScenario[] = [
  {
    name: 'text-turn',
    prompt: 'Reply with exactly: SDK snapshot OK',
    sessionId: 'sdk-snapshot-text',
    children: 0,
  },
  {
    name: 'bash-tool',
    prompt: 'Run this exact command with your bash tool, then reply with its stdout only: echo dsh-sdk-proof-7391',
    sessionId: 'sdk-snapshot-bash',
    children: 0,
  },
  {
    name: 'subagent-spawn',
    prompt: "Use the subagent tool exactly once with description 'echo probe' and prompt: Reply with exactly: child answer 42. Then reply with the subagent's final answer verbatim.",
    sessionId: 'sdk-snapshot-subagent',
    children: 1,
  },
]

interface PersistedLog {
  readonly path: string
  readonly content: string
  readonly header: Record<string, unknown>
}

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true })
  return entries.filter(entry => entry.endsWith('.jsonl')).map(entry => join(dir, entry)).sort()
}

async function persistedLogs(sessionsRoot: string): Promise<PersistedLog[]> {
  const files = await jsonlFiles(sessionsRoot)
  return Promise.all(files.map(async (path) => {
    const content = await readFile(path, 'utf8')
    const header = JSON.parse(content.slice(0, content.indexOf('\n'))) as Record<string, unknown>
    return { path, content, header }
  }))
}

function contextOf(logs: readonly { content: string; header: Record<string, unknown> }[], cwd: string): NormalizeContext {
  return {
    sessionIds: logs.flatMap(log => typeof log.header.id === 'string' ? [log.header.id] : []),
    cwd,
  }
}

function contextOfContents(contents: readonly string[]): NormalizeContext {
  const headers = contents.map(content => JSON.parse(content.slice(0, content.indexOf('\n'))) as Record<string, unknown>)
  return {
    sessionIds: headers.flatMap(header => typeof header.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0no-cwd\0',
  }
}

/**
 * Normalize the SDK-visible notification stream: embedded `session.event`
 * envelopes get the session-log treatment (times zeroed, headers tokenized),
 * then every record is scrubbed like a wire frame.
 */
function normalizeNotifications(notifications: readonly HarnessNotification[], ctx: NormalizeContext): string {
  const events = notifications
    .filter(n => n.method === 'session.event')
    .map(n => n.params.event as Record<string, unknown>)
  const normalizedEvents = events.length === 0
    ? []
    : scrubRequestHeaders(normalizeSessionLog(
      `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
      ctx,
    )).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  let eventIndex = 0
  const records = notifications.map((notification) => {
    if (notification.method !== 'session.event') return { method: notification.method, params: notification.params }
    const event = normalizedEvents[eventIndex++]
    return { method: notification.method, params: { ...notification.params, event } }
  })
  return normalizeStdout(`${records.map(record => JSON.stringify(record)).join('\n')}\n`, ctx)
}

/** Normalize the turn-result projection (status, reason kind, final text). */
function normalizeResult(result: TurnResult, ctx: NormalizeContext): string {
  return normalizeStdout(`${JSON.stringify({
    status: result.status,
    reason: result.reason,
    finalResponse: result.finalResponse,
  })}\n`, ctx)
}

/** One SDK turn against a fresh runtime subprocess in an isolated cwd. */
async function runScenario(scenario: SdkScenario): Promise<{
  result: TurnResult
  notifications: HarnessNotification[]
  logs: PersistedLog[]
  cwd: string
}> {
  const cwd = await mkdtemp(join(tmpdir(), `sdk-snapshot-${scenario.name}-`))
  const sessionsRoot = join(cwd, '.sessions')
  const scenarioDir = join(snapshotsDir, scenario.name)
  const launch = resolveExampleLaunch({
    srcBin: runtimeBin,
    configArgs: [],
    tsconfigPath: repoTsconfig,
  })
  const childFixtures = Array.from(
    { length: scenario.children },
    (_, index) => join(scenarioDir, `session.${index + 1}.jsonl`),
  )
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    ...Object.fromEntries(Object.entries(launch.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    DSH_CORDIS_CONFIG: recording ? liveConfig : replayConfig,
    DSH_SESSION_ROOT: sessionsRoot,
    DSH_CWD: cwd,
    DSH_SNAPSHOT: mode,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    ...recording ? {} : {
      DSH_SNAPSHOT_FILE: join(scenarioDir, 'session.jsonl'),
      ...childFixtures.length > 0 ? { DSH_SNAPSHOT_CHILD_FILES: childFixtures.join(delimiter) } : {},
    },
  }

  const harness = new DeepSeekHarness({
    launch: {
      command: launch.command,
      args: launch.args,
      cwd,
      env,
      requestTimeoutMs: 110_000,
    },
    cwd,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  })
  try {
    const notifications: HarnessNotification[] = []
    const result = await harness.run(scenario.prompt, {
      sessionId: scenario.sessionId,
      onNotification: (notification) => { notifications.push(notification) },
    })
    await harness.close()
    const logs = await persistedLogs(sessionsRoot)
    return { result, notifications, logs, cwd }
  } finally {
    await harness.close()
    await rm(cwd, { recursive: true, force: true })
  }
}

/** Order logs parent-first, children by creation time (fixture layout order). */
function orderLogs(logs: PersistedLog[], scenario: SdkScenario): PersistedLog[] {
  const parents = logs.filter(log => typeof log.header.parentSession !== 'string')
  const children = logs.filter(log => typeof log.header.parentSession === 'string')
    .sort((left, right) => Number(left.header.createdAt) - Number(right.header.createdAt))
  expect(parents).toHaveLength(1)
  expect(children).toHaveLength(scenario.children)
  return [...parents, ...children]
}

function fixtureFiles(scenario: SdkScenario): string[] {
  const dir = join(snapshotsDir, scenario.name)
  return [
    join(dir, 'session.jsonl'),
    ...Array.from({ length: scenario.children }, (_, index) => join(dir, `session.${index + 1}.jsonl`)),
  ]
}

describe('TypeScript SDK snapshots over the jsonrpc runtime', () => {
  for (const scenario of SCENARIOS) {
    it(`replays ${scenario.name} through the SDK`, async () => {
      const scenarioDir = join(snapshotsDir, scenario.name)
      const notificationsExpectedPath = join(scenarioDir, 'notifications.expected.jsonl')
      const resultExpectedPath = join(scenarioDir, 'result.expected.json')

      const { result, notifications, logs, cwd } = await runScenario(scenario)
      const ordered = orderLogs(logs, scenario)
      const actualContext = contextOf(ordered, cwd)

      if (recording) {
        // Fixtures carry tokenized request headers; llm-replay reads only
        // assistant output and tool traffic, so scrubbing keeps prompts and
        // schemas out of the corpus without affecting replay.
        await mkdir(scenarioDir, { recursive: true })
        await Promise.all(ordered.map(async (log, index) => {
          const file = fixtureFiles(scenario)[index]
          if (file === undefined) throw new Error(`no fixture path for persisted log ${index}`)
          await writeFile(file, scrubRequestHeaders(tokenizeSessionFixtureCwd(log.content)))
        }))
      }

      const files = fixtureFiles(scenario)
      let expectedContents = await Promise.all(files.map(file => readFile(file, 'utf8')))

      if (refreshing) {
        const harvested = ordered.map((log): HarvestedLog => ({
          id: String(log.header.id),
          createdAt: Number(log.header.createdAt),
          ...typeof log.header.parentSession === 'string' ? { parentSession: log.header.parentSession } : {},
          content: log.content,
        }))
        const replacements = refreshFixtureReplacements(harvested, expectedContents)
        expectedContents = await Promise.all(ordered.map(async (log, index) => {
          const existing = expectedContents[index]
          const file = files[index]
          if (existing === undefined || file === undefined) throw new Error(`no fixture for persisted log ${index}`)
          const stable = scrubRequestHeaders(tokenizeSessionFixtureCwd(
            stabilizeRefreshLog(log.content, existing, replacements, actualContext),
          ))
          await writeFile(file, stable)
          return stable
        }))
      }

      for (const [index, expected] of expectedContents.entries()) {
        expect(scrubRequestHeaders(expected), `${scenario.name} session fixture ${index} carries request-header bulk`)
          .toBe(expected)
      }

      // Persisted transcripts match the committed fixtures.
      const expectedContext = contextOfContents(expectedContents)
      for (const [index, log] of ordered.entries()) {
        const expected = expectedContents[index]
        if (expected === undefined) throw new Error(`no fixture for persisted log ${index}`)
        expect(scrubRequestHeaders(normalizeSessionLog(log.content, actualContext)))
          .toBe(scrubRequestHeaders(normalizeSessionLog(expected, expectedContext)))
      }

      // The SDK-visible wire stream and turn result match their expected outputs.
      const normalizedNotifications = normalizeNotifications(notifications, actualContext)
      const normalizedResult = normalizeResult(result, actualContext)
      if (recording || refreshing) {
        await writeFile(notificationsExpectedPath, normalizedNotifications)
        await writeFile(resultExpectedPath, normalizedResult)
      }
      expect(normalizedNotifications).toBe(await readFile(notificationsExpectedPath, 'utf8'))
      expect(normalizedResult).toBe(await readFile(resultExpectedPath, 'utf8'))

      // Wire-shape invariants that must hold in every mode.
      expect(result.status).toBe('ok')
      expect(notifications.at(-1)?.method).toBe('session.finished')
      if (scenario.children > 0) {
        expect(notifications.some(n => n.method === 'subagent.started')).toBe(true)
        expect(notifications.some(n => n.method === 'subagent.finished')).toBe(true)
      }
    })
  }
})
