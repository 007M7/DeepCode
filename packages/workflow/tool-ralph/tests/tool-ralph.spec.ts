import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { WorkflowRunId, WorkflowService } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult, WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import * as toolRalph from '../src/index.ts'

class StubEngine extends WorkflowService {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  settle!: (result: WorkflowResult) => void
  startError: Error | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError !== undefined) throw this.startError
    this.requests.push(request)
    const result = new Promise<WorkflowResult>((resolve) => { this.settle = resolve })
    return {
      id: WorkflowRunId(`ralph-${this.requests.length}`),
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({
          value: null,
          stopReason: 'cancelled',
          ...reason === undefined ? {} : { error: reason },
          agentsStarted: 0,
        })
      },
      dispose: () => {
        this.disposed += 1
        return Promise.resolve()
      },
    }
  }
}

class StubProvider implements SubagentProvider {
  readonly name = 'fresh'
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean

  constructor(options?: { outputSchema?: boolean; inheritsParentContext?: boolean }) {
    this.capabilities = {
      outputSchema: options?.outputSchema ?? true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    }
    this.inheritsParentContext = options?.inheritsParentContext ?? false
  }

  start(_request: SubagentStartRequest): Promise<SubagentRun> {
    return Promise.reject(new Error('StubProvider.start must not be reached behind StubEngine'))
  }
}

interface SetupOptions {
  config?: toolRalph.Config
  provider?: StubProvider | false
}

async function setup(options?: SetupOptions) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(SubagentService)
  const provider = options?.provider === false ? undefined : options?.provider ?? new StubProvider()
  if (provider !== undefined) ctx.subagents.registerProvider(provider)
  await ctx.plugin(StubEngine)
  const config: toolRalph.Config = { subagentProvider: 'fresh' }
  if (options?.config?.subagentProvider !== undefined) config.subagentProvider = options.config.subagentProvider
  if (options?.config?.maxRounds !== undefined) config.maxRounds = options.config.maxRounds
  if (options?.config?.maxHandoffChars !== undefined) config.maxHandoffChars = options.config.maxHandoffChars
  const fiber = await ctx.plugin(toolRalph, config)
  const parent = { id: SessionId('caller'), options: {} } as unknown as Agent
  return { ctx, engine: ctx.workflows as StubEngine, parent, fiber }
}

function execute(
  ctx: Context,
  args: unknown,
  extra?: { agent?: Agent; signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: CallId('ralph-call'),
    name: 'ralph',
    arguments: args,
    ...extra?.agent === undefined ? {} : { agent: extra.agent },
    ...extra?.signal === undefined ? {} : { signal: extra.signal },
  })
}

const CONTINUE = {
  status: 'continue',
  summary: 'Implemented the first slice.',
  evidence: ['Focused tests pass.'],
  nextSteps: ['Implement the second slice.'],
  blocker: '',
}

const COMPLETE = {
  status: 'complete',
  summary: 'The objective is complete.',
  evidence: ['All required gates pass.'],
  nextSteps: [],
  blocker: '',
}

const BLOCKED = {
  status: 'blocked',
  summary: 'No local work can progress.',
  evidence: ['The required remote service is unavailable.'],
  nextSteps: ['Retry after service recovery.'],
  blocker: 'The required remote service is unavailable.',
}

async function settleCompleted(
  engine: StubEngine,
  pending: Promise<ToolExecutionResult>,
  value: unknown,
  agentsStarted = 1,
): Promise<ToolExecutionResult> {
  await vi.waitFor(() => { expect(engine.requests.length).toBeGreaterThan(0) })
  engine.settle({ value, stopReason: 'completed', agentsStarted })
  return pending
}

describe('dsh-tool-ralph', () => {
  it('starts the fixed workflow through the configured fresh provider and renders completion', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxRounds: 9, maxHandoffChars: 9000 } })
    const pending = execute(ctx, { objective: '  Finish the migration.  ', maxRounds: 4 }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    expect(engine.requests[0]).toMatchObject({
      meta: { name: 'ralph-loop' },
      args: { objective: 'Finish the migration.', maxRounds: 4, maxHandoffChars: 9000 },
      subagentProvider: 'fresh',
      parent,
    })
    expect(engine.requests[0]!.script).toContain("status: 'budget-limited'")
    const result = await settleCompleted(engine, pending, {
      status: 'complete',
      roundsStarted: 1,
      report: COMPLETE,
    })
    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('Ralph completed after 1 round.')
    expect((result.content[0] as { text: string }).text).toContain('All required gates pass.')
    expect(engine.disposed).toBe(1)
  })

  it('renders blocked and budget-limited terminal outcomes as bounded successful results', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxRounds: 2 } })
    const blocked = execute(ctx, { objective: 'Ship it.' }, { agent: parent })
    const blockedResult = await settleCompleted(engine, blocked, {
      status: 'blocked',
      roundsStarted: 2,
      report: BLOCKED,
    }, 2)
    expect((blockedResult.content[0] as { text: string }).text).toContain('Ralph blocked after 2 rounds.')

    const limited = execute(ctx, { objective: 'Ship it.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    const limitedResult = await settleCompleted(engine, limited, {
      status: 'budget-limited',
      roundsStarted: 2,
      report: CONTINUE,
    }, 2)
    expect((limitedResult.content[0] as { text: string }).text)
      .toContain('Ralph reached its 2 rounds limit with work remaining.')
  })

  it('maps workflow error and cancellation reasons to tool errors and always disposes', async () => {
    const { ctx, engine, parent } = await setup()
    const failed = execute(ctx, { objective: 'Work.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settle({ value: null, stopReason: 'error', error: 'child report malformed', agentsStarted: 1 })
    expect(((await failed).content[0] as { text: string }).text)
      .toContain('Ralph workflow failed: child report malformed')

    const unknown = execute(ctx, { objective: 'Work.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    engine.settle({ value: null, stopReason: 'error', agentsStarted: 0 })
    expect(((await unknown).content[0] as { text: string }).text).toContain('unknown error')

    const cancelled = execute(ctx, { objective: 'Work.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(3) })
    engine.settle({ value: null, stopReason: 'cancelled', error: 'user stopped', agentsStarted: 0 })
    expect(((await cancelled).content[0] as { text: string }).text).toContain('cancelled (user stopped)')

    const bare = execute(ctx, { objective: 'Work.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(4) })
    engine.settle({ value: null, stopReason: 'cancelled', agentsStarted: 0 })
    expect(((await bare).content[0] as { text: string }).text).toMatch(/cancelled$/)
    expect(engine.disposed).toBe(4)
  })

  it('bridges mid-flight and already-aborted parent signals to cancellation', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { objective: 'Work.' }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    controller.abort()
    expect((await pending).isError).toBe(true)

    const already = new AbortController()
    already.abort()
    expect((await execute(ctx, { objective: 'Work.' }, { agent: parent, signal: already.signal })).isError).toBe(true)
    expect(engine.cancels).toEqual(['parent step aborted', 'parent step aborted'])
    expect(engine.disposed).toBe(2)
  })

  it('rejects absent authority, empty objectives, bad round caps, and schema-invalid calls before start', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxRounds: 3 } })
    expect((await execute(ctx, { objective: 'Work.' })).isError).toBe(true)
    expect((await execute(ctx, { objective: '   ' }, { agent: parent })).isError).toBe(true)
    for (const maxRounds of [0, 1.5, Number.NaN, 4]) {
      expect((await execute(ctx, { objective: 'Work.', maxRounds }, { agent: parent })).isError).toBe(true)
    }
    const missing = await execute(ctx, {}, { agent: parent })
    expect(missing.error?.code).toBe('INVALID_ARGS')
    expect(engine.requests).toHaveLength(0)
  })

  it('rejects missing, unstructured, and parent-context-inheriting provider routes', async () => {
    const missing = await setup({ provider: false })
    expect(((await execute(missing.ctx, { objective: 'Work.' }, { agent: missing.parent })).content[0] as { text: string }).text)
      .toContain('is not registered')
    expect(missing.engine.requests).toHaveLength(0)

    const unstructured = await setup({ provider: new StubProvider({ outputSchema: false }) })
    expect(((await execute(unstructured.ctx, { objective: 'Work.' }, { agent: unstructured.parent })).content[0] as { text: string }).text)
      .toContain('does not support structured output')

    const inherited = await setup({ provider: new StubProvider({ inheritsParentContext: true }) })
    expect(((await execute(inherited.ctx, { objective: 'Work.' }, { agent: inherited.parent })).content[0] as { text: string }).text)
      .toContain('inherits parent context')
  })

  it('rejects invalid direct-apply config before touching injected services', () => {
    expect(() => { toolRalph.apply(new Context(), { subagentProvider: ' ' }) }).toThrow('non-empty normalized')
    expect(() => { toolRalph.apply(new Context(), { maxRounds: 0 }) }).toThrow('positive safe integer')
    expect(() => { toolRalph.apply(new Context(), { maxHandoffChars: 1.5 }) }).toThrow('positive safe integer')
  })

  it('turns malformed fixed-workflow terminal values and reports into errors', async () => {
    const cases: { value: unknown; message: string; config?: toolRalph.Config }[] = [
      { value: null, message: 'malformed terminal result' },
      { value: { status: 'complete', roundsStarted: 0, report: COMPLETE }, message: 'malformed terminal result' },
      { value: { status: 'complete', roundsStarted: 3, report: COMPLETE }, message: 'malformed terminal result', config: { maxRounds: 2 } },
      { value: { status: 'mystery', roundsStarted: 1, report: COMPLETE }, message: 'unknown terminal status' },
      { value: { status: 'budget-limited', roundsStarted: 1, report: CONTINUE }, message: 'before the round limit', config: { maxRounds: 2 } },
      { value: { status: 'complete', roundsStarted: 1, report: null }, message: 'malformed round report' },
      { value: { status: 'complete', roundsStarted: 1, report: { ...COMPLETE, status: 'continue' } }, message: 'malformed round report' },
      { value: { status: 'budget-limited', roundsStarted: 1, report: { ...CONTINUE, nextSteps: [] } }, message: 'invalid continuing report', config: { maxRounds: 1 } },
      { value: { status: 'complete', roundsStarted: 1, report: { ...COMPLETE, evidence: [] } }, message: 'invalid completion report' },
      { value: { status: 'blocked', roundsStarted: 1, report: { ...BLOCKED, blocker: '' } }, message: 'invalid blocked report' },
      { value: { status: 'complete', roundsStarted: 1, report: { ...COMPLETE, summary: 'x'.repeat(500) } }, message: 'oversized handoff', config: { maxHandoffChars: 100 } },
    ]
    for (const testCase of cases) {
      const { ctx, engine, parent } = await setup(
        testCase.config === undefined ? undefined : { config: testCase.config },
      )
      const result = await settleCompleted(
        engine,
        execute(ctx, { objective: 'Work.', ...testCase.config?.maxRounds === undefined ? {} : { maxRounds: testCase.config.maxRounds } }, { agent: parent }),
        testCase.value,
      )
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain(testCase.message)
    }
  })

  it('surfaces a synchronous engine start failure without inventing a run', async () => {
    const { ctx, engine, parent } = await setup()
    engine.startError = new Error('engine refused fixed script')
    const result = await execute(ctx, { objective: 'Work.' }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('engine refused fixed script')
    expect(engine.disposed).toBe(0)
  })

  it('registers scoped guidance and pure replay-safe generic presentation', async () => {
    const { ctx, fiber } = await setup()
    const section = (await ctx.systemPrompt.assemble()).sections.find(candidate => candidate.name === 'tool:ralph')
    expect(section?.text).toContain('ONLY when the direct human explicitly asks')
    const tool = ctx.tools.get('ralph')!
    expect(tool.presentCall!({ objective: 'Finish it.' })).toEqual({
      card: 'generic',
      title: 'ralph',
      rawInput: 'Finish it.',
    })
    expect(tool.presentResult!({ objective: 'Finish it.' }, { content: [], isError: false })).toEqual({ card: 'generic' })
    expect(tool.presentCall!({ nope: true })).toBeUndefined()
    await fiber.dispose()
    expect(ctx.tools.get('ralph')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.some(candidate => candidate.name === 'tool:ralph')).toBe(false)
  })

  it('has the namespace-plugin export shape', () => {
    expect('default' in toolRalph).toBe(false)
    expect(toolRalph.name).toBe('tool-ralph')
    expect(toolRalph.inject).toEqual(['tools', 'workflows', 'subagents', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolRalph) as Record<string, unknown>
    expect(unwrapped).toBe(toolRalph)
    expect(typeof unwrapped.apply).toBe('function')
  })
})
