// Keyless assembled-browser evidence for the opt-in Schedule overlay. A real
// root Agent receives schedule_create through the complete tool pipeline; the
// one-second owner path queues a best-effort followup, commits dispatch, and
// renders the Host's durability-gated reminder sidecar. A separate browser
// scenario drives local at through the real zone wire and model tool call. A
// JSONL restart lane resumes backdated fixed-rate records,
// captures their exact batch framing, and renders both receipts. No model
// fixture is installed: later prompt failure cannot retract a receipt.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'
import {
  ScheduleId,
  createAfterScheduleRecord,
  foldScheduleEvents,
  scheduleReminderPresentation,
} from '@deepseek-ai/dsh-tool-schedule'
import type { EveryScheduleRecord } from '@deepseek-ai/dsh-tool-schedule'
import {
  createCronScheduleRecord,
  createEveryScheduleRecord,
  resolveEveryOccurrence,
} from '../../../packages/schedule/tool-schedule/src/domain.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('../../../examples/web-schedule/cordis.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/schedule-after', import.meta.url))
const RECEIPT_EXPECTED = fileURLToPath(new URL('./snapshots/schedule-after/receipt.expected.md', import.meta.url))
const AT_RECEIPT_EXPECTED = fileURLToPath(new URL('./snapshots/schedule-after/at-receipt.expected.md', import.meta.url))
const EVERY_BATCH_EXPECTED = fileURLToPath(new URL('./snapshots/schedule-after/every-batch.expected.md', import.meta.url))
const EVERY_RECEIPT_EXPECTED = fileURLToPath(new URL('./snapshots/schedule-after/every-receipt.expected.md', import.meta.url))
const MIXED_BATCH_EXPECTED = fileURLToPath(new URL('./snapshots/schedule-after/mixed-batch.expected.md', import.meta.url))
const CRON_RECEIPT_EXPECTED = fileURLToPath(new URL('./snapshots/schedule-after/cron-receipt.expected.md', import.meta.url))
const SESSION_TIME_ZONE = 'UTC'
const PROMPT = 'Check the deployment log'
const AT_PROMPT = 'Review the release window'
const EVERY_PROMPTS = ['Check primary metrics', 'Check secondary metrics'] as const
const AT_RECEIPT_SELECTOR = '[data-schedule-reminder]:has-text("Review the release window")'

interface CreatedScheduleView {
  id: string
  kind: 'after' | 'at' | 'every' | 'cron'
  scheduledAt: string
  deliveryMode: 'session-local'
}

/** Deterministic model boundary that selects local at relative to its actual first request. */
class BrowserZoneAtAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  scheduledAt: string | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000 })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const target = Math.ceil((Date.now() + 10_000) / 1_000) * 1_000
      const scheduledAt = new Date(target).toISOString()
      this.scheduledAt = scheduledAt
      const args = JSON.stringify({
        prompt: AT_PROMPT,
        at: { date: scheduledAt.slice(0, 10), time: scheduledAt.slice(11, 19) },
      })
      const callId = CallId('schedule-at-wire-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta', index: 0, id: callId,
        name: 'schedule_create', argumentsDelta: args,
      }
      yield {
        type: 'block-end', index: 0,
        block: { type: 'tool-call', id: callId, name: 'schedule_create', arguments: args },
      }
      yield { type: 'usage', usage: { inputTokens: 256, outputTokens: 32 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = this.requests.length === 2
      ? 'The zone-aware reminder is scheduled.'
      : 'The zone-aware reminder is due.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 128, outputTokens: 16 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Wait for one in-process lifecycle fact without using test-scoped expect.poll in beforeAll. */
async function waitForFact(read: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!read()) {
    if (Date.now() >= deadline) throw new Error(`Schedule lifecycle fact did not arrive within ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Give a seeded Session one completed turn so the real Host fork path can cut it. */
function appendCompletedTurn(session: Session, prompt: string): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

describe.skipIf(MODE === 'record')('web e2e: durable after reminder receipt', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let browser: Browser
  let page: Page
  let scheduleId = ''
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('schedule-after-web-e2e'),
      meta: { cwd: scaffold.workspaceCwd, timeZone: SESSION_TIME_ZONE },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const workspace = await scaffold.ctx.workspace.create(scaffold.workspaceCwd, 'Schedule')
    await workspace.attachSession(agentHandle.agent.id)

    const created = await scaffold.ctx.tools.execute({
      signal: AbortSignal.timeout(10_000),
      callId: CallId('schedule-after-create'),
      name: 'schedule_create',
      arguments: { prompt: PROMPT, after_seconds: 1 },
      agent: agentHandle.agent,
    })
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error(created.error.message)
    const value = created.value as unknown as CreatedScheduleView
    expect(value.deliveryMode).toBe('session-local')
    scheduleId = value.id
    expect(scheduleId.length).toBeGreaterThan(0)

    await waitForFact(() => agentHandle.agent.session.events.some(event =>
      event.type === 'schedule/change'
      && (event.data as { operation?: unknown }).operation === 'dispatch'), 15_000)
    await expect(scaffold.ctx.sessions.flush(agentHandle.agent.session)).resolves.toBe(true)
    const durable = await scaffold.ctx.sessionPersistence.inspect(agentHandle.agent.id)
    expect(durable.meta).toMatchObject(agentHandle.agent.session.header)
    expect({ ...durable.meta, delegationDepth: durable.meta.delegationDepth ?? 0 }).toEqual({
      ...agentHandle.agent.session.header,
      delegationDepth: agentHandle.agent.session.header.delegationDepth ?? 0,
    })
    expect(durable.events).toEqual(agentHandle.agent.session.events.slice(0, durable.events.length))
    const history = await scaffold.ctx.apiProxy.sessions.history({
      rpcId: RpcId('schedule-history-baseline'), payload: { sessionId: agentHandle.agent.id },
    })
    if (!history.result.ok) throw new Error(history.result.error.message)
    expect(history.result.value.events?.find(entry =>
      entry.event.type === 'schedule/change'
      && (entry.event.data as { operation?: unknown }).operation === 'dispatch')?.view).toMatchObject({
      for: 'event',
    })
    await waitForFact(
      () => agentHandle.agent.session.events.some(event => event.type === 'turn/start'),
      10_000,
    )
    await waitForFact(() => agentHandle.agent.session.events.some(event =>
      event.type === 'user/message'
      && (event.data as { source?: { plugin?: unknown } }).source?.plugin === 'time-context'), 10_000)
    const timeReading = agentHandle.agent.session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'time-context')
    if (timeReading?.type !== 'user/message') throw new Error('missing time-context reading')
    const timeText = timeReading.data.content.find(block => block.type === 'text')?.text
    if (timeText === undefined) throw new Error('missing time-context text')
    expect(timeReading.data.source).toEqual({
      kind: 'plugin',
      plugin: 'time-context',
      form: 'snapshot',
      sections: [{ name: 'time-context', text: timeText }],
    })
    expect(timeText).toContain(`Session time zone: ${SESSION_TIME_ZONE}.`)
    expect(timeText).toContain('Client time zone for this request: missing.')
    const listed = await scaffold.ctx.apiProxy.sessions.list({
      rpcId: RpcId('schedule-list-baseline'), payload: {},
    })
    if (!listed.result.ok) throw new Error(listed.result.error.message)
    expect(listed.result.value.items.find(item => item.sessionId === agentHandle.agent.id)?.blank).toBe(false)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Schedule Web evidence teardown failed')
  })

  it('renders the committed reminder from attached history', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-schedule-after'))
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    // Startup auto-selection can race the first disclosure gesture. Converge
    // on the expanded state instead of letting that later update collapse it.
    await expect.poll(async () => {
      if (await group.getAttribute('aria-expanded') !== 'true') {
        await group.click()
        await page.waitForTimeout(50)
      }
      return await group.getAttribute('aria-expanded')
    }, { timeout: 5_000 }).toBe('true')
    const session = page.locator('[role="treeitem"][aria-selected]').nth(1)
    await session.waitFor({ timeout: 10_000 })
    await session.click()

    const receipt = page.locator('[data-schedule-reminder]')
    await receipt.waitFor({ timeout: 15_000 })
    expect(await receipt.getByText(PROMPT, { exact: true }).count()).toBe(1)
    expect(await receipt.getByText('Delivered in this session only', { exact: true }).count()).toBe(1)
    const snapshot = (await captureStableAria(page, '[data-schedule-reminder]', scaffold.workspaceCwd))
      .split(scheduleId).join('{{scheduleId}}')
      .replace(/\d{4}-\d{2}-\d{2}T(?:\d{2}:\d{2}:\d{2}\.\d{3}|\{\{clock\}\})Z/gu, '{{occurrenceAt}}')
    await compareOrRefreshGolden(RECEIPT_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'at-receipt.expected.md',
      'cron-receipt.expected.md',
      'every-batch.expected.md',
      'every-receipt.expected.md',
      'mixed-batch.expected.md',
      'receipt.expected.md',
    ])
  })
})

describe.skipIf(MODE === 'record')('web e2e: browser-zone local at reminder', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const adapter = new BrowserZoneAtAdapter()

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      fixtureAdapter: adapter,
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: 'en-US',
      timezoneId: SESSION_TIME_ZONE,
    })
    await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'schedule-at-wire-e2e')
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Schedule at wire evidence teardown failed')
  })

  it('carries the browser zone through prompt context, local at, and the durable receipt', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-schedule-at-wire'))
    const composer = page.locator('textarea:enabled').last()
    await composer.fill('Schedule the release-window reminder in my local time.')
    const settled = scaffold.whenTurnSettled(60_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const sessionId = await settled
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('browser-created Schedule Session has no live Agent')
    expect(agent.session.header.timeZone).toBe(SESSION_TIME_ZONE)

    const request = agent.session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'user'
      && event.data.content.some(block => block.type === 'text'
        && block.text === 'Schedule the release-window reminder in my local time.'))
    if (request?.type !== 'user/message' || request.data.source.kind !== 'user') {
      throw new Error('missing browser user-rpc message')
    }
    expect(request.data.source).toMatchObject({
      kind: 'user',
      clientTimeZone: SESSION_TIME_ZONE,
    })
    expect(typeof (request.data.source as { rpcId?: unknown }).rpcId).toBe('string')

    const timeContextIndex = agent.session.events.findIndex(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'time-context'
      && event.data.content.some(block => block.type === 'text'
        && block.text.includes('Session time zone: UTC.')
        && block.text.includes('Client time zone for this request: UTC.')))
    const toolCallIndex = agent.session.events.findIndex(event =>
      event.type === 'tool/call' && event.data.name === 'schedule_create')
    expect(timeContextIndex).toBeGreaterThanOrEqual(0)
    expect(toolCallIndex).toBeGreaterThan(timeContextIndex)

    const firstRequest = adapter.requests[0]
    if (firstRequest === undefined) throw new Error('model did not receive the browser prompt')
    expect(JSON.stringify(firstRequest.messages)).toContain('Session time zone: UTC.')
    expect(JSON.stringify(firstRequest.messages)).toContain('Client time zone for this request: UTC.')
    expect(firstRequest.tools?.some(tool => tool.name === 'schedule_create')).toBe(true)

    const scheduledAt = adapter.scheduledAt
    if (scheduledAt === undefined) throw new Error('model did not choose a local at target')
    const created = agent.session.events.find(event =>
      event.type === 'schedule/change'
      && event.data.operation === 'create'
      && event.data.schedule.kind === 'at'
      && event.data.schedule.scheduledAt === scheduledAt)
    if (created?.type !== 'schedule/change' || created.data.operation !== 'create') {
      throw new Error('local at tool call did not create its durable record')
    }
    const scheduleId = created.data.schedule.id
    await waitForFact(() => agent.session.events.some(event =>
      event.type === 'schedule/change'
      && event.data.operation === 'dispatch'
      && event.data.id === scheduleId), 20_000)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    await expect(scaffold.ctx.sessions.flush(agent.session)).resolves.toBe(true)

    const history = await scaffold.ctx.apiProxy.sessions.history({
      rpcId: RpcId('schedule-at-wire-history'),
      payload: { sessionId },
    })
    if (!history.result.ok) throw new Error(history.result.error.message)
    expect(history.result.value.events?.find(entry =>
      entry.event.type === 'schedule/change'
      && entry.event.data.operation === 'dispatch'
      && entry.event.data.id === scheduleId)?.view).toMatchObject({
      for: 'event',
      view: { scheduleId, prompt: AT_PROMPT, occurrenceAt: scheduledAt },
    })

    const receipt = page.locator(AT_RECEIPT_SELECTOR)
    await receipt.waitFor({ timeout: 20_000 })
    const snapshot = (await captureStableAria(page, AT_RECEIPT_SELECTOR, scaffold.workspaceCwd))
      .split(scheduleId).join('{{scheduleId}}')
      .replace(/\d{4}-\d{2}-\d{2}T(?:\d{2}:\d{2}:\d{2}\.\d{3}|\{\{clock\}\})Z/gu, '{{occurrenceAt}}')
    await compareOrRefreshGolden(AT_RECEIPT_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'at-receipt.expected.md',
      'cron-receipt.expected.md',
      'every-batch.expected.md',
      'every-receipt.expected.md',
      'mixed-batch.expected.md',
      'receipt.expected.md',
    ])
  })
})

describe.skipIf(MODE === 'record')('web e2e: fixed-rate restart and batch receipts', () => {
  it('resumes backdated JSONL records, accepts each latest occurrence once, and renders both receipts', async () => {
    const workspaceCwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-schedule-every-ws-')))
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-schedule-every-sessions-'))
    const world = { workspaceCwd, persistenceRoot }
    const sessionId = SessionId('schedule-every-restart')
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    try {
      scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, world })
      const workspace = await scaffold.ctx.workspace.create(workspaceCwd, 'Schedule every restart')
      const seeded = scaffold.ctx.sessions.create(sessionId, {
        meta: { cwd: workspaceCwd, timeZone: SESSION_TIME_ZONE },
      })
      appendCompletedTurn(seeded, 'seed fixed-rate reminders')
      seeded.append('session/title', {
        title: 'Every restart session', messageSeqs: [], source: { kind: 'user' },
      })
      const seededAt = Date.now()
      const records: readonly [EveryScheduleRecord, EveryScheduleRecord] = [
        {
          id: ScheduleId('schedule-every-primary'),
          kind: 'every',
          prompt: EVERY_PROMPTS[0],
          everySeconds: 300,
          scheduledAt: new Date(seededAt - 900_000).toISOString(),
        },
        {
          id: ScheduleId('schedule-every-secondary'),
          kind: 'every',
          prompt: EVERY_PROMPTS[1],
          everySeconds: 300,
          scheduledAt: new Date(seededAt - 840_000).toISOString(),
        },
      ]
      const [primary, secondary] = records
      const recordIds = new Set(records.map(record => record.id))
      for (const record of records) {
        seeded.append('schedule/change', { version: 1, operation: 'create', schedule: record })
      }
      await expect(scaffold.ctx.sessions.flush(seeded)).resolves.toBe(true)
      await workspace.attachSession(sessionId)
      await scaffold.close()
      scaffold = undefined

      scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, world })
      const resumedWorkspace = await scaffold.ctx.workspace.create(workspaceCwd, 'Schedule every restart')
      await resumedWorkspace.attachSession(sessionId)
      const resumed = await scaffold.ctx.apiProxy.sessions.create({
        rpcId: RpcId('schedule-every-resume'),
        payload: { sessionId, cwd: workspaceCwd, timeZone: SESSION_TIME_ZONE },
      })
      if (!resumed.result.ok) throw new Error(resumed.result.error.message)
      const agent = scaffold.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('fixed-rate Session did not resume')
      await waitForFact(() => records.every(record => agent.session.events.some(event =>
        event.type === 'schedule/change'
        && event.data.operation === 'dispatch'
        && event.data.id === record.id)), 15_000)
      await agent.whenIdle()
      await expect(scaffold.ctx.sessions.flush(agent.session)).resolves.toBe(true)

      const dispatches = agent.session.events.filter(event =>
        event.type === 'schedule/change'
        && event.data.operation === 'dispatch'
        && recordIds.has(event.data.id))
      expect(dispatches).toHaveLength(2)
      const accepted = dispatches.map((event) => {
        if (event.type !== 'schedule/change' || event.data.operation !== 'dispatch'
          || !('acceptedAt' in event.data)) throw new Error('expected recurring dispatch')
        return event.data.acceptedAt
      })
      expect(new Set(accepted).size).toBe(1)
      const acceptedAt = accepted[0]
      if (acceptedAt === undefined) throw new Error('missing recurring batch time')
      const folded = foldScheduleEvents(agent.session.events)
      for (const record of records) {
        const active = folded.active.find(candidate => candidate.id === record.id)
        if (active === undefined) throw new Error(`missing active every record ${record.id}`)
        expect(active).toMatchObject({ kind: 'every', everySeconds: 300 })
        expect(Date.parse(active.scheduledAt)).toBeGreaterThan(Date.parse(acceptedAt))
      }
      const batchMessages = agent.session.events.filter(event =>
        event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'tool-schedule'
        && event.data.content.some(block =>
          block.type === 'text' && block.text.startsWith('[SCHEDULE REMINDER BATCH]')))
      expect(batchMessages).toHaveLength(1)
      const batchMessage = batchMessages[0]
      if (batchMessage?.type !== 'user/message') throw new Error('missing recurring batch message')
      const batchBlock = batchMessage.data.content.find(block => block.type === 'text')
      if (batchBlock?.type !== 'text') throw new Error('missing recurring batch text')
      let batchSnapshot = batchBlock.text
      const occurrencePlaceholders = ['{{primaryOccurrenceAt}}', '{{secondaryOccurrenceAt}}'] as const
      for (const [index, record] of records.entries()) {
        const dispatch = dispatches.find(event => event.type === 'schedule/change'
          && event.data.operation === 'dispatch'
          && event.data.id === record.id)
        if (dispatch?.type !== 'schedule/change') throw new Error(`missing dispatch for ${record.id}`)
        const occurrenceAt = scheduleReminderPresentation(
          agent.session.events,
          dispatch.seq,
          agent.session.header.seedLength ?? 0,
        )?.occurrenceAt
        if (occurrenceAt === undefined) throw new Error(`missing receipt occurrence for ${record.id}`)
        batchSnapshot = batchSnapshot.split(occurrenceAt).join(occurrencePlaceholders[index])
      }
      await compareOrRefreshGolden(EVERY_BATCH_EXPECTED, batchSnapshot, MODE)

      const history = await scaffold.ctx.apiProxy.sessions.history({
        rpcId: RpcId('schedule-every-history'), payload: { sessionId },
      })
      if (!history.result.ok) throw new Error(history.result.error.message)
      const receiptViews = history.result.value.events?.filter(entry =>
        entry.event.type === 'schedule/change'
        && entry.event.data.operation === 'dispatch'
        && recordIds.has(entry.event.data.id))
      expect(receiptViews?.map(entry => entry.view?.view)).toEqual([
        expect.objectContaining({ scheduleId: primary.id, prompt: EVERY_PROMPTS[0] }),
        expect.objectContaining({ scheduleId: secondary.id, prompt: EVERY_PROMPTS[1] }),
      ])

      browser = await chromium.launch()
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const group = page.locator('[role="treeitem"]').first()
      await group.waitFor({ timeout: 15_000 })
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
      const session = page.locator('[role="treeitem"]:has-text("Every restart session")')
      await session.waitFor({ timeout: 10_000 })
      await session.click()
      for (const prompt of EVERY_PROMPTS) {
        const receipt = page.locator(`[data-schedule-reminder]:has-text("${prompt}")`)
        await receipt.waitFor({ timeout: 15_000 })
        expect(await receipt.getByText(prompt, { exact: true }).count()).toBe(1)
      }
      const selector = `[data-schedule-reminder]:has-text("${EVERY_PROMPTS[0]}")`
      const snapshot = (await captureStableAria(page, selector, workspaceCwd))
        .split(primary.id).join('{{scheduleId}}')
        .replace(/\d{4}-\d{2}-\d{2}T(?:\d{2}:\d{2}:\d{2}\.\d{3}|\{\{clock\}\})Z/gu, '{{occurrenceAt}}')
      await compareOrRefreshGolden(EVERY_RECEIPT_EXPECTED, snapshot, MODE)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      const failures: unknown[] = []
      await browser?.close().catch((error: unknown) => failures.push(error))
      await scaffold?.close().catch((error: unknown) => failures.push(error))
      await rm(workspaceCwd, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
      await rm(persistenceRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Every Web evidence teardown failed')
    }
  }, 120_000)
})

describe.skipIf(MODE === 'record')('web e2e: Cron restart and final mixed batch', () => {
  it('dispatches an overdue one-shot before Every and Cron share one batch', async () => {
    const workspaceCwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-schedule-cron-ws-')))
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-schedule-cron-sessions-'))
    const world = { workspaceCwd, persistenceRoot }
    const sessionId = SessionId('schedule-cron-restart')
    const ids = {
      once: ScheduleId('schedule-mixed-once'),
      every: ScheduleId('schedule-mixed-every'),
      cron: ScheduleId('schedule-mixed-cron'),
    }
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    try {
      scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, world })
      const workspace = await scaffold.ctx.workspace.create(workspaceCwd, 'Schedule Cron restart')
      const seeded = scaffold.ctx.sessions.create(sessionId, {
        meta: { cwd: workspaceCwd, timeZone: SESSION_TIME_ZONE },
      })
      appendCompletedTurn(seeded, 'seed mixed recurring reminders')
      seeded.append('session/title', {
        title: 'Cron restart session', messageSeqs: [], source: { kind: 'user' },
      })
      const seededAt = Date.now()
      const oneShot = createAfterScheduleRecord(ids.once, 'One-shot bypass', 1, seededAt - 60_000)
      const every = createEveryScheduleRecord(ids.every, 'Fixed-rate mixed reminder', 300, seededAt - 600_000)
      const cronEpoch = Math.floor((seededAt - 60_000) / 60_000) * 60_000
      const cron = createCronScheduleRecord(
        ids.cron,
        'Calendar mixed reminder',
        `${new Date(cronEpoch).getUTCMinutes()} ${new Date(cronEpoch).getUTCHours()} * * *`,
        'UTC',
        cronEpoch - 86_400_000,
      )
      expect(Date.parse(cron.scheduledAt)).toBe(cronEpoch)
      for (const record of [oneShot, every, cron]) {
        seeded.append('schedule/change', { version: 1, operation: 'create', schedule: record })
      }
      await expect(scaffold.ctx.sessions.flush(seeded)).resolves.toBe(true)
      await workspace.attachSession(sessionId)
      await scaffold.close()
      scaffold = undefined

      scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, world })
      const resumedWorkspace = await scaffold.ctx.workspace.create(workspaceCwd, 'Schedule Cron restart')
      await resumedWorkspace.attachSession(sessionId)
      const resumed = await scaffold.ctx.apiProxy.sessions.create({
        rpcId: RpcId('schedule-cron-resume'),
        payload: { sessionId, cwd: workspaceCwd, timeZone: SESSION_TIME_ZONE },
      })
      if (!resumed.result.ok) throw new Error(resumed.result.error.message)
      const agent = scaffold.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('Cron Session did not resume')

      await waitForFact(() => [ids.once, ids.every, ids.cron].every(id => agent.session.events.some(event =>
        event.type === 'schedule/change'
        && event.data.operation === 'dispatch'
        && event.data.id === id)), 15_000)
      await agent.whenIdle()
      await expect(scaffold.ctx.sessions.flush(agent.session)).resolves.toBe(true)

      const recurringDispatches = agent.session.events.filter(event =>
        event.type === 'schedule/change'
        && event.data.operation === 'dispatch'
        && (event.data.id === ids.every || event.data.id === ids.cron))
      expect(recurringDispatches).toHaveLength(2)
      const oneShotDispatch = agent.session.events.find(event =>
        event.type === 'schedule/change'
        && event.data.operation === 'dispatch'
        && event.data.id === ids.once)
      if (oneShotDispatch?.type !== 'schedule/change') throw new Error('missing one-shot dispatch')
      expect(oneShotDispatch.seq).toBeLessThan(Math.min(...recurringDispatches.map(event => event.seq)))
      const acceptedAt = recurringDispatches.map((event) => {
        if (event.type !== 'schedule/change' || event.data.operation !== 'dispatch'
          || !('acceptedAt' in event.data)) throw new Error('expected recurring dispatch')
        return event.data.acceptedAt
      })
      expect(new Set(acceptedAt).size).toBe(1)
      const batchAcceptedAt = acceptedAt[0]
      if (batchAcceptedAt === undefined) throw new Error('missing mixed batch time')
      const cronDispatch = recurringDispatches.find(event =>
        event.type === 'schedule/change' && event.data.operation === 'dispatch' && event.data.id === ids.cron)
      if (cronDispatch?.type !== 'schedule/change' || cronDispatch.data.operation !== 'dispatch'
        || !('occurrenceAt' in cronDispatch.data)) throw new Error('missing Cron dispatch')
      expect(cronDispatch.data.nextScheduledAt).toBeDefined()

      const batchMessages = agent.session.events.filter(event =>
        event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'tool-schedule'
        && event.data.content.some(block =>
          block.type === 'text' && block.text.startsWith('[SCHEDULE REMINDER BATCH]')))
      expect(batchMessages).toHaveLength(1)
      const batchMessage = batchMessages[0]
      if (batchMessage?.type !== 'user/message') throw new Error('missing mixed batch message')
      const batchBlock = batchMessage.data.content.find(block => block.type === 'text')
      if (batchBlock?.type !== 'text') throw new Error('missing mixed batch text')
      const everyOccurrence = resolveEveryOccurrence(every, Date.parse(batchAcceptedAt)).occurrenceAt
      const batchSnapshot = batchBlock.text
        .split(everyOccurrence).join('{{everyOccurrenceAt}}')
        .split(cronDispatch.data.occurrenceAt).join('{{cronOccurrenceAt}}')
      await compareOrRefreshGolden(MIXED_BATCH_EXPECTED, batchSnapshot, MODE)

      const history = await scaffold.ctx.apiProxy.sessions.history({
        rpcId: RpcId('schedule-cron-history'), payload: { sessionId },
      })
      if (!history.result.ok) throw new Error(history.result.error.message)
      const receiptViews = history.result.value.events?.filter(entry =>
        entry.event.type === 'schedule/change'
        && entry.event.data.operation === 'dispatch'
        && (entry.event.data.id === ids.once
          || entry.event.data.id === ids.every
          || entry.event.data.id === ids.cron))
      expect(receiptViews?.map(entry => entry.view?.view)).toEqual([
        expect.objectContaining({ scheduleId: ids.once, prompt: oneShot.prompt }),
        expect.objectContaining({ scheduleId: ids.every, prompt: every.prompt }),
        expect.objectContaining({ scheduleId: ids.cron, prompt: cron.prompt }),
      ])

      browser = await chromium.launch()
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const group = page.locator('[role="treeitem"]').first()
      await group.waitFor({ timeout: 15_000 })
      await expect.poll(async () => {
        if (await group.getAttribute('aria-expanded') !== 'true') {
          await group.click()
          await page.waitForTimeout(50)
        }
        return await group.getAttribute('aria-expanded')
      }, { timeout: 5_000 }).toBe('true')
      await expect.poll(async () => {
        const rows = page.locator('[role="treeitem"]')
        for (let index = 1; index < await rows.count(); index += 1) {
          await rows.nth(index).click()
          if (await page.getByText(cron.prompt, { exact: true }).count() > 0) return true
        }
        return false
      }, { timeout: 15_000 }).toBe(true)
      for (const prompt of [oneShot.prompt, every.prompt, cron.prompt]) {
        const receipt = page.locator(`[data-schedule-reminder]:has-text("${prompt}")`)
        await receipt.waitFor({ timeout: 15_000 })
        expect(await receipt.getByText(prompt, { exact: true }).count()).toBe(1)
      }
      const cronSelector = `[data-schedule-reminder]:has-text("${cron.prompt}")`
      const snapshot = (await captureStableAria(page, cronSelector, workspaceCwd))
        .split(ids.cron).join('{{scheduleId}}')
        .replace(/\d{4}-\d{2}-\d{2}T(?:\d{2}:\d{2}:\d{2}\.\d{3}|\{\{clock\}\})Z/gu, '{{occurrenceAt}}')
      await compareOrRefreshGolden(CRON_RECEIPT_EXPECTED, snapshot, MODE)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      const failures: unknown[] = []
      await browser?.close().catch((error: unknown) => failures.push(error))
      await scaffold?.close().catch((error: unknown) => failures.push(error))
      await rm(workspaceCwd, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
      await rm(persistenceRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Cron Web evidence teardown failed')
    }
  }, 120_000)
})

describe.skipIf(MODE === 'record')('web e2e: Schedule restart, fork, and cold history', () => {
  it('preserves pending work, commits one overdue receipt, and replays it cold without activation', async () => {
    const workspaceCwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-schedule-restart-ws-')))
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-schedule-restart-sessions-'))
    const world = { workspaceCwd, persistenceRoot }
    const pendingId = SessionId('schedule-restart-pending')
    const deliveredId = SessionId('schedule-restart-delivered')
    let scaffold: WebScaffold | undefined
    try {
      scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, world })
      const workspace = await scaffold.ctx.workspace.create(workspaceCwd, 'Schedule restart')

      const pending = scaffold.ctx.sessions.create(pendingId, { meta: { cwd: workspaceCwd } })
      appendCompletedTurn(pending, 'pending parent turn')
      pending.append('session/title', {
        title: 'Pending restart session', messageSeqs: [], source: { kind: 'user' },
      })
      const pendingRecord = createAfterScheduleRecord(
        ScheduleId('schedule-pending'), 'Pending across restart', 3_600, Date.now(),
      )
      pending.append('schedule/change', { version: 1, operation: 'create', schedule: pendingRecord })
      await expect(scaffold.ctx.sessions.flush(pending)).resolves.toBe(true)
      await workspace.attachSession(pendingId)

      const delivered = scaffold.ctx.sessions.create(deliveredId, { meta: { cwd: workspaceCwd } })
      appendCompletedTurn(delivered, 'delivered parent turn')
      delivered.append('session/title', {
        title: 'Delivered restart session', messageSeqs: [], source: { kind: 'user' },
      })
      const overdueRecord = createAfterScheduleRecord(
        ScheduleId('schedule-delivered'), 'Delivered after restart', 1, Date.now() - 60_000,
      )
      delivered.append('schedule/change', { version: 1, operation: 'create', schedule: overdueRecord })
      await expect(scaffold.ctx.sessions.flush(delivered)).resolves.toBe(true)
      await workspace.attachSession(deliveredId)

      await scaffold.close()
      scaffold = undefined

      scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, world })
      const pendingResume = await scaffold.ctx.apiProxy.sessions.create({
        rpcId: RpcId('schedule-pending-resume'),
        payload: { sessionId: pendingId, cwd: workspaceCwd, timeZone: 'UTC' },
      })
      if (!pendingResume.result.ok) throw new Error(pendingResume.result.error.message)
      const pendingAgent = scaffold.ctx.agents.get(pendingId)
      if (pendingAgent === undefined) throw new Error('pending Session did not resume')
      expect(foldScheduleEvents(
        pendingAgent.session.events,
        pendingAgent.session.header.seedLength ?? 0,
      ).active).toEqual([expect.objectContaining({ id: 'schedule-pending' })])

      const forked = await scaffold.ctx.apiProxy.sessions.fork({
        rpcId: RpcId('schedule-pending-fork'),
        payload: { sessionId: pendingId },
      })
      if (!forked.result.ok) throw new Error(forked.result.error.message)
      const child = scaffold.ctx.agents.get(forked.result.value.sessionId)
      if (child === undefined) throw new Error('fork child was not published')
      expect(foldScheduleEvents(
        child.session.events,
        child.session.header.seedLength ?? 0,
      ).active).toEqual([])

      const deliveredResume = await scaffold.ctx.apiProxy.sessions.create({
        rpcId: RpcId('schedule-delivered-resume'),
        payload: { sessionId: deliveredId, cwd: workspaceCwd, timeZone: 'UTC' },
      })
      if (!deliveredResume.result.ok) throw new Error(deliveredResume.result.error.message)
      const deliveredAgent = scaffold.ctx.agents.get(deliveredId)
      if (deliveredAgent === undefined) throw new Error('overdue Session did not resume')
      await waitForFact(() => deliveredAgent.session.events.some(event =>
        event.type === 'schedule/change' && event.data.operation === 'dispatch'), 15_000)
      await deliveredAgent.whenIdle()
      await expect(scaffold.ctx.sessions.flush(deliveredAgent.session)).resolves.toBe(true)
      expect(deliveredAgent.session.events.filter(event =>
        event.type === 'schedule/change' && event.data.operation === 'dispatch')).toHaveLength(1)

      await scaffold.close()
      scaffold = undefined

      scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, world })
      expect(scaffold.ctx.agents.get(deliveredId)).toBeUndefined()
      const coldHistory = await scaffold.ctx.apiProxy.sessions.history({
        rpcId: RpcId('schedule-cold-history'),
        payload: { sessionId: deliveredId },
      })
      if (!coldHistory.result.ok) throw new Error(coldHistory.result.error.message)
      const dispatchEntries = coldHistory.result.value.events.filter(entry =>
        entry.event.type === 'schedule/change'
        && entry.event.data.operation === 'dispatch')
      expect(dispatchEntries).toHaveLength(1)
      expect(dispatchEntries[0]?.view?.for).toBe('event')
      expect(scaffold.ctx.agents.get(deliveredId)).toBeUndefined()

      await scaffold.close()
      scaffold = undefined

      scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, world })
      const replayed = await scaffold.ctx.apiProxy.sessions.create({
        rpcId: RpcId('schedule-delivered-replay'),
        payload: { sessionId: deliveredId, cwd: workspaceCwd, timeZone: 'UTC' },
      })
      if (!replayed.result.ok) throw new Error(replayed.result.error.message)
      const replayedAgent = scaffold.ctx.agents.get(deliveredId)
      if (replayedAgent === undefined) throw new Error('delivered Session did not resume again')
      await replayedAgent.whenIdle()
      await expect(scaffold.ctx.sessions.flush(replayedAgent.session)).resolves.toBe(true)
      expect(replayedAgent.session.events.filter(event =>
        event.type === 'schedule/change' && event.data.operation === 'dispatch')).toHaveLength(1)
    } finally {
      const failures: unknown[] = []
      await scaffold?.close().catch((error: unknown) => failures.push(error))
      await rm(workspaceCwd, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
      await rm(persistenceRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Schedule restart evidence teardown failed')
    }
  }, 180_000)
})
