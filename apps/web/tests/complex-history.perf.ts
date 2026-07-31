// Opt-in browser benchmark for high-cardinality workspace and history
// rendering. It reports measurements without timing assertions because host
// speed is not a correctness contract; structural assertions keep the load
// shape from silently shrinking.
import { performance } from 'node:perf_hooks'
import type { Browser, CDPSession, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
// Carries the session/title event declaration into the fixture builder.
import type {} from '@deepseek-ai/dsh-session-title'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SIDEBAR_SESSION_COUNT = 1_000
const LONG_SESSION_ID = 'perf-long-history'
const LONG_SESSION_TITLE = 'LONG_PERF_SENTINEL 500-turn session'
const LONG_HISTORY_TURNS = 500
const TOOL_TURN_INTERVAL = 10
const TOOLS_PER_TOOL_TURN = 10
const EXPECTED_TOOL_CALLS = LONG_HISTORY_TURNS / TOOL_TURN_INTERVAL * TOOLS_PER_TOOL_TURN
const EXPECTED_TRAJECTORY_ROWS = 2_100

interface ChromiumMetrics {
  readonly [name: string]: number
}

interface Measurement {
  readonly wallMs: number
  readonly taskMs: number
  readonly scriptMs: number
  readonly layoutMs: number
  readonly recalcStyleMs: number
  readonly devtoolsMs: number
  readonly nodesDelta: number
  readonly listenersDelta: number
  readonly heapDeltaMb: number
  readonly totalNodes: number
  readonly heapMb: number
}

function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

function appendTitle(session: Session, title: string, messageSeq: number): void {
  session.append('session/title', {
    title,
    messageSeqs: [messageSeq],
    source: { kind: 'fallback' },
  })
}

function appendRequestHeader(session: Session, turn: number, step: number): void {
  session.append('request/header', {
    header: {
      config: { provider: 'synthetic-perf', model: 'synthetic-perf' },
      system: `Synthetic performance system prompt for turn ${String(turn)}, step ${String(step)}.`,
    },
    reason: turn === 1 && step === 1 ? 'initial' : 'change',
  })
}

function appendAssistant(
  session: Session,
  turn: number,
  step: number,
  body: string,
): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: text(body),
      source: { provider: 'synthetic-perf', model: 'synthetic-perf' },
    }),
    usage: {
      inputTokens: 4_000 + turn * 10,
      outputTokens: 200 + step * 20,
      cacheReadTokens: turn % 2 === 0 ? 2_000 : 0,
    },
  }, { surfaceOp: 'append' })
}

function appendToolStep(
  session: Session,
  turn: number,
  step: number,
  toolCount: number,
): void {
  const calls = Array.from({ length: toolCount }, (_, index) => {
    const callId = CallId(`perf-call-${String(turn)}-${String(index)}`)
    const args = JSON.stringify({
      turn,
      index,
      payload: 'x'.repeat(120),
    })
    return { callId, index, args }
  })

  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [
        {
          type: 'reasoning',
          text: `Dispatching ${String(toolCount)} synthetic tools for turn ${String(turn)}.`,
        },
        ...calls.map(({ callId, args }) => ({
          type: 'tool-call' as const,
          id: callId,
          name: 'synthetic_tool',
          arguments: args,
        })),
      ],
      source: { provider: 'synthetic-perf', model: 'synthetic-perf' },
    }),
    usage: {
      inputTokens: 6_000 + turn * 10,
      outputTokens: 500,
      cacheReadTokens: 3_000,
      reasoningTokens: 50,
    },
  }, { surfaceOp: 'append' })

  const callEvents = calls.map(({ callId, args }) =>
    session.append('tool/call', {
      turn,
      step,
      callId,
      name: 'synthetic_tool',
      arguments: args,
    }))

  for (const [index, call] of calls.entries()) {
    const source = callEvents[index]
    if (source === undefined) throw new Error(`missing synthetic tool call ${String(index)}`)
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId: call.callId,
        content: text(
          `synthetic result turn=${String(turn)} index=${String(call.index)} ${'r'.repeat(400)}`,
        ),
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
}

function fencedCode(turn: number): string {
  if (turn % 25 !== 0) return ''
  const lines = Array.from(
    { length: 80 },
    (_, index) => `const value_${String(index)} = ${String(turn + index)}`,
  )
  return `\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\``
}

function fixtureLog(session: Session): string {
  const header = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: '{{sessionId}}',
    createdAt: Date.now() - 60_000,
    cwd: '{{cwd}}',
  }
  return [
    JSON.stringify(header),
    ...session.events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

function smallSidebarFixture(): string {
  const session = new Session(SessionId('perf-small-template'))
  session.append('turn/start', {
    turn: 1,
    trigger: { kind: 'message', source: { kind: 'user' } },
  })
  const user = session.append('user/message', createUserMessage({
    content: text('Inspect this compact synthetic session.'),
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  appendTitle(session, 'Synthetic sidebar session', user.seq)
  session.append('step/start', { turn: 1, step: 1 })
  appendRequestHeader(session, 1, 1)
  appendToolStep(session, 1, 1, 2)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  appendRequestHeader(session, 1, 2)
  appendAssistant(session, 1, 2, 'Synthetic sidebar fixture complete.')
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return fixtureLog(session)
}

function longHistoryFixture(): string {
  const session = new Session(SessionId(LONG_SESSION_ID))
  for (let turn = 1; turn <= LONG_HISTORY_TURNS; turn += 1) {
    session.append('turn/start', {
      turn,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    const user = session.append('user/message', createUserMessage({
      content: text(
        `LONG_PERF_SENTINEL turn ${String(turn)}: analyze payload ${'u'.repeat(200)}`,
      ),
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) appendTitle(session, LONG_SESSION_TITLE, user.seq)

    session.append('step/start', { turn, step: 1 })
    appendRequestHeader(session, turn, 1)
    if (turn % TOOL_TURN_INTERVAL === 0) {
      appendToolStep(session, turn, 1, TOOLS_PER_TOOL_TURN)
      session.append('step/end', { turn, step: 1 })
      session.append('step/start', { turn, step: 2 })
      appendRequestHeader(session, turn, 2)
      appendAssistant(
        session,
        turn,
        2,
        `All synthetic tools completed for turn ${String(turn)}. ${'z'.repeat(320)}${fencedCode(turn)}`,
      )
      session.append('step/end', { turn, step: 2 })
    } else {
      appendAssistant(
        session,
        turn,
        1,
        `Synthetic assistant response for turn ${String(turn)}. ${'a'.repeat(320)}${fencedCode(turn)}`,
      )
      session.append('step/end', { turn, step: 1 })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return fixtureLog(session)
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

async function chromiumMetrics(cdp: CDPSession): Promise<ChromiumMetrics> {
  const payload = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(payload.metrics.map(metric => [metric.name, metric.value]))
}

function requiredMetric(metrics: ChromiumMetrics, name: string): number {
  const value = metrics[name]
  if (value === undefined) throw new Error(`Chromium performance metric ${name} is unavailable`)
  return value
}

function metricDelta(
  before: ChromiumMetrics,
  after: ChromiumMetrics,
  wallMs: number,
): Measurement {
  return {
    wallMs: rounded(wallMs),
    taskMs: rounded((requiredMetric(after, 'TaskDuration') - requiredMetric(before, 'TaskDuration')) * 1_000),
    scriptMs: rounded((requiredMetric(after, 'ScriptDuration') - requiredMetric(before, 'ScriptDuration')) * 1_000),
    layoutMs: rounded((requiredMetric(after, 'LayoutDuration') - requiredMetric(before, 'LayoutDuration')) * 1_000),
    recalcStyleMs: rounded(
      (requiredMetric(after, 'RecalcStyleDuration') - requiredMetric(before, 'RecalcStyleDuration')) * 1_000,
    ),
    devtoolsMs: rounded(
      (requiredMetric(after, 'DevToolsCommandDuration') - requiredMetric(before, 'DevToolsCommandDuration')) * 1_000,
    ),
    nodesDelta: requiredMetric(after, 'Nodes') - requiredMetric(before, 'Nodes'),
    listenersDelta: requiredMetric(after, 'JSEventListeners') - requiredMetric(before, 'JSEventListeners'),
    heapDeltaMb: rounded(
      (requiredMetric(after, 'JSHeapUsedSize') - requiredMetric(before, 'JSHeapUsedSize')) / 1_048_576,
    ),
    totalNodes: requiredMetric(after, 'Nodes'),
    heapMb: rounded(requiredMetric(after, 'JSHeapUsedSize') / 1_048_576),
  }
}

async function measure<T>(
  cdp: CDPSession,
  action: () => Promise<T>,
): Promise<{ measurement: Measurement; value: T }> {
  const before = await chromiumMetrics(cdp)
  const started = performance.now()
  const value = await action()
  const wallMs = performance.now() - started
  const after = await chromiumMetrics(cdp)
  return { measurement: metricDelta(before, after, wallMs), value }
}

async function stableCount(
  locator: Locator,
  accepts: (count: number) => boolean,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = performance.now() + timeoutMs
  let previous = -1
  let stableReads = 0
  while (performance.now() < deadline) {
    const count = await locator.count()
    stableReads = accepts(count) && count === previous ? stableReads + 1 : 0
    if (stableReads >= 4) return count
    previous = count
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`browser row count did not stabilize; last count ${String(previous)}`)
}

async function conversationTurns(page: Page): Promise<number> {
  const stats = page.getByText(/\d+ turns · \d+ steps/, { exact: true }).last()
  await stats.waitFor({ timeout: 15_000 })
  const value = await stats.textContent()
  const match = value?.match(/^(\d+) turns · \d+ steps$/)
  if (match?.[1] === undefined) throw new Error(`unexpected conversation stats ${JSON.stringify(value)}`)
  return Number(match[1])
}

describe('manual web performance: complex workspace and history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let setupMs = 0
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const setupStarted = performance.now()
    scaffold = await launchWebScaffold({})
    const small = smallSidebarFixture()
    for (let index = 0; index < SIDEBAR_SESSION_COUNT; index += 1) {
      await seedSession(scaffold, small, `perf-sidebar-${String(index).padStart(4, '0')}`)
    }
    await seedSession(scaffold, longHistoryFixture(), LONG_SESSION_ID)
    setupMs = performance.now() - setupStarted

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reports sidebar, paging, and trajectory rendering costs', async () => {
    const bootStarted = performance.now()
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const group = page.getByRole('treeitem').first()
    await expect.poll(() => group.textContent(), { timeout: 30_000 })
      .toContain(`${String(SIDEBAR_SESSION_COUNT + 1)} sessions`)
    const bootReadyMs = performance.now() - bootStarted

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const firstContentfulPaintMs = await page.evaluate(
      () => globalThis.performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
    )

    const sidebar = await measure(cdp, async () => {
      await group.click()
      return stableCount(
        page.getByRole('treeitem'),
        count => count === SIDEBAR_SESSION_COUNT + 2,
      )
    })
    expect(sidebar.value).toBe(SIDEBAR_SESSION_COUNT + 2)

    await group.click()
    await expect.poll(() => page.getByRole('treeitem').count()).toBe(1)

    const contentSearch = await measure(cdp, async () => {
      await page.getByRole('textbox', { name: 'Search name, keywords...', exact: true })
        .fill('LONG_PERF_SENTINEL')
      const results = page.getByRole('tree', { name: 'Search results' })
        .getByRole('treeitem')
      await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
      const result = results.first()
      await result.waitFor({ timeout: 60_000 })
      return result
    })

    const openLongHistory = await measure(cdp, async () => {
      await contentSearch.value.click()
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).waitFor({ timeout: 30_000 })
      return conversationTurns(page)
    })
    expect(openLongHistory.value).toBeGreaterThan(0)

    const trajectoryRows = page.getByRole('row')
    const coldTrajectory = await measure(cdp, async () => {
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
      return stableCount(trajectoryRows, count => count === EXPECTED_TRAJECTORY_ROWS)
    })
    expect(coldTrajectory.value).toBe(EXPECTED_TRAJECTORY_ROWS)

    const collapseTurns = await measure(cdp, async () => {
      await page.getByRole('button', { name: 'Collapse turns', exact: true }).click()
      return stableCount(trajectoryRows, count => count > 0 && count < EXPECTED_TRAJECTORY_ROWS)
    })
    expect(collapseTurns.value).toBeLessThan(EXPECTED_TRAJECTORY_ROWS)

    const trajectorySearch = await measure(cdp, async () => {
      await page.getByRole('searchbox', { name: 'Search trajectory', exact: true }).fill('turn 499')
      return stableCount(trajectoryRows, count => count > 0 && count < 20)
    })
    expect(trajectorySearch.value).toBeLessThan(20)

    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    const historyPages: { turns: number; measurement: Measurement }[] = []
    let turns = await conversationTurns(page)
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const previousTurns = turns
      const older = await measure(cdp, async () => {
        await page.getByRole('button', { name: 'Load earlier', exact: true }).click()
        await expect.poll(() => conversationTurns(page), { timeout: 30_000 }).toBeGreaterThan(previousTurns)
        return conversationTurns(page)
      })
      turns = older.value
      historyPages.push({ turns, measurement: older.measurement })
    }

    const warmTrajectory = await measure(cdp, async () => {
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
      return stableCount(trajectoryRows, count => count === EXPECTED_TRAJECTORY_ROWS)
    })
    expect(warmTrajectory.value).toBe(EXPECTED_TRAJECTORY_ROWS)

    const report = {
      fixture: {
        sidebarSessions: SIDEBAR_SESSION_COUNT,
        totalSessions: SIDEBAR_SESSION_COUNT + 1,
        longHistoryTurns: LONG_HISTORY_TURNS,
        toolCalls: EXPECTED_TOOL_CALLS,
        trajectoryRows: EXPECTED_TRAJECTORY_ROWS,
      },
      setupMs: rounded(setupMs),
      boot: {
        readyMs: rounded(bootReadyMs),
        firstContentfulPaintMs: firstContentfulPaintMs === undefined
          ? null
          : rounded(firstContentfulPaintMs),
      },
      sidebarExpand: sidebar.measurement,
      contentSearch: contentSearch.measurement,
      openLongHistory: {
        initialTurns: openLongHistory.value,
        ...openLongHistory.measurement,
      },
      coldTrajectory: {
        rows: coldTrajectory.value,
        ...coldTrajectory.measurement,
      },
      collapseTurns: {
        rows: collapseTurns.value,
        ...collapseTurns.measurement,
      },
      trajectorySearch: {
        rows: trajectorySearch.value,
        ...trajectorySearch.measurement,
      },
      historyPages,
      warmTrajectory: {
        rows: warmTrajectory.value,
        ...warmTrajectory.measurement,
      },
    }
    console.info(`WEB_PERF_RESULT ${JSON.stringify(report, null, 2)}`)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
