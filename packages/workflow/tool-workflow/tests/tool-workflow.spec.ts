import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { AgentId } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowRunId, WorkflowService } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult, WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { CallId } from '@deepseek-ai/dsh-llm'
import SubagentService from '@deepseek-ai/dsh-subagent'
import VmWorkflowEngine from '@deepseek-ai/dsh-workflow-vm'
import * as toolWorkflow from '../src/index.ts'

/** A controllable engine standing in behind ctx.workflows (the tool's only seam). */
class StubEngine extends WorkflowService {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  settle!: (result: WorkflowResult) => void
  startError: Error | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError) throw this.startError
    this.requests.push(request)
    const result = new Promise<WorkflowResult>((resolve) => { this.settle = resolve })
    request.signal?.addEventListener('abort', () => {
      this.settle({ value: null, stopReason: 'cancelled', error: 'signal', agentsStarted: 0 })
    }, { once: true })
    return {
      id: WorkflowRunId('run-1'),
      meta: { name: 'stub-flow', description: 'd' },
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({ value: null, stopReason: 'cancelled', ...reason !== undefined ? { error: reason } : {}, agentsStarted: 0 })
      },
      dispose: () => {
        this.disposed += 1
        return Promise.resolve()
      },
    }
  }
}

async function setup(config?: { toolName?: string; maxResultChars?: number }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(StubEngine)
  await ctx.plugin(toolWorkflow, config ?? {})
  const engine = ctx.workflows as StubEngine
  const parent = { id: AgentId('caller'), options: {} } as unknown as Agent
  return { ctx, engine, parent }
}

const SCRIPT = "export const meta = { name: 'audit', description: 'd' }\nreturn 1"

function execute(ctx: Context, args: unknown, extra?: { agent?: Agent; signal?: AbortSignal }): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: CallId('call-1'),
    name: 'workflow',
    arguments: args,
    ...extra?.agent ? { agent: extra.agent } : {},
    ...extra?.signal ? { signal: extra.signal } : {},
  })
}

describe('dsh-tool-workflow', () => {
  it('starts a run with the script/args/parent/signal and renders the completed value', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { script: SCRIPT, args: { files: ['a.ts'] } }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    expect(engine.requests[0]).toMatchObject({ script: SCRIPT, args: { files: ['a.ts'] }, parent })
    expect(engine.requests[0]!.signal).toBe(controller.signal)
    engine.settle({ value: { findings: [1, 2] }, stopReason: 'completed', agentsStarted: 7 })
    const result = await pending
    expect(result.isError).toBe(false)
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('workflow "stub-flow" completed (7 agents)')
    expect(rendered).toContain('"findings"')
    expect(engine.disposed).toBe(1)
  })

  it('maps a non-completed stop reason to an isError result (and still disposes)', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'error', error: 'script threw: boom', agentsStarted: 2 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('workflow run failed: script threw: boom')
    expect(engine.disposed).toBe(1)
  })

  it('reports a cancelled run distinctly (with and without a reason)', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'cancelled', error: 'user', agentsStarted: 0 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('workflow run was cancelled (user)')

    const bare = execute(ctx, { script: SCRIPT }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(2) })
    engine.settle({ value: null, stopReason: 'cancelled', agentsStarted: 0 })
    expect(((await bare).content[0] as { text: string }).text.trim().endsWith('cancelled')).toBe(true)
  })

  it('an error result without a message renders the unknown-error fallback', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'error', agentsStarted: 0 })
    expect(((await pending).content[0] as { text: string }).text).toContain('unknown error')
  })

  it('cancels the run when exec.signal aborts MID-FLIGHT (the abort bridge)', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { script: SCRIPT }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(engine.cancels).toContain('parent step aborted')
    expect(engine.disposed).toBe(1)
  })

  it('applies raw-config fallbacks when loaded without schemastery defaults (direct apply)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(StubEngine)
    // Direct apply with an empty RAW config: the `??` fallbacks resolve the
    // tool name and render cap without schemastery having filled them.
    toolWorkflow.apply(ctx, {})
    expect(ctx.tools.get('workflow')).toBeDefined()
  })

  it('a synchronous engine start throw (parse/meta failure) becomes an isError result', async () => {
    const { ctx, engine, parent } = await setup()
    engine.startError = new Error('script must begin with `export const meta = {...}`')
    const result = await execute(ctx, { script: 'nope' }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('must begin with')
  })

  it('requires a calling agent (fails loud without exec.agent)', async () => {
    const { ctx, engine } = await setup()
    const result = await execute(ctx, { script: SCRIPT })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires a calling agent')
    expect(engine.requests.length).toBe(0)
  })

  it('validates its own arguments via the schema DSL (missing script)', async () => {
    const { ctx, parent } = await setup()
    const result = await execute(ctx, {}, { agent: parent })
    expect(result.isError).toBe(true)
    expect(result.error?.code).toBe('INVALID_ARGS')
  })

  it('cancels the run when exec.signal is ALREADY aborted at call time', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await execute(ctx, { script: SCRIPT }, { agent: parent, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(engine.cancels).toContain('parent step aborted')
    expect(engine.disposed).toBe(1)
  })

  it('truncates an oversized rendered value with a notice (maxResultChars)', async () => {
    const { ctx, engine, parent } = await setup({ maxResultChars: 40 })
    const pending = execute(ctx, { script: SCRIPT }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: { blob: 'x'.repeat(500) }, stopReason: 'completed', agentsStarted: 1 })
    const rendered = ((await pending).content[0] as { text: string }).text
    expect(rendered).toContain('[truncated:')
    expect(rendered.length).toBeLessThan(400)
  })

  it('registers under a configured toolName and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(StubEngine)
    const fiber = await ctx.plugin(toolWorkflow, { toolName: 'orchestrate' })
    expect(ctx.tools.get('orchestrate')).toBeDefined()
    expect(ctx.tools.get('workflow')).toBeUndefined()
    await fiber.dispose()
    expect(ctx.tools.get('orchestrate')).toBeUndefined()
  })

  it('presents a generic pending card titled by the sniffed meta name, with the script as rawInput', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    const view = tool.presentCall!({ script: SCRIPT })
    expect(view).toMatchObject({ card: 'generic', title: 'workflow: audit', rawInput: SCRIPT })
    const anonymous = tool.presentCall!({ script: 'export const meta = {}\nreturn 1' })
    expect(anonymous).toMatchObject({ card: 'generic', title: 'workflow' })
  })

  it('presentResult keeps the generic card; presentation is pure and replay-safe on malformed args', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    expect(tool.presentResult!({ script: SCRIPT }, { content: [], isError: false })).toEqual({ card: 'generic' })
    // defineTool soft-validates presentation args: a malformed logged shape
    // falls back to undefined instead of throwing mid-replay.
    expect(tool.presentCall!({ not: 'the schema' })).toBeUndefined()
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in toolWorkflow).toBe(false)
    expect(toolWorkflow.name).toBe('tool-workflow')
    expect(toolWorkflow.inject).toEqual(['tools', 'workflows', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolWorkflow) as Record<string, unknown>
    expect(unwrapped).toBe(toolWorkflow)
    expect(typeof unwrapped.apply).toBe('function')
  })

  describe('composition with the REAL vm engine (the mock above must stay honest)', () => {
    it('an abort releases the tool even when the script parks on a promise no hook owns', async () => {
      // Regression for the review-found turn wedge: the tool awaits
      // run.result BEFORE its disposing finally, the registry and the loop
      // await the tool — so if cancellation could not settle result (a script
      // parked on `await new Promise(() => {})`), an aborted turn stayed
      // wedged forever. The seam now guarantees result settles within the
      // grace of cancel(); this drives that guarantee through the real
      // registry + real tool + real engine.
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(SubagentService)
      await ctx.plugin(VmWorkflowEngine, { disposeGraceMs: 30 })
      await ctx.plugin(toolWorkflow, {})
      const parent = { id: AgentId('caller'), options: {} } as unknown as Agent
      const controller = new AbortController()
      const pending = execute(ctx, {
        script: "export const meta = { name: 'stuck', description: 'parks forever' }\nawait new Promise(() => {})\nreturn 1",
      }, { agent: parent, signal: controller.signal })
      // Give the run a beat to start (past its synchronous slice), then abort.
      await new Promise(resolve => setTimeout(resolve, 20))
      controller.abort('user abort')
      const result = await pending
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('cancelled')
    })
  })
})
