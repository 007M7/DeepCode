import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as spawn from '../src/index.ts'
import { depthOf, STRUCTURED_OUTPUT_TOOL, SubagentDepthError } from '@deepseek-ai/dsh-subagent-inprocess'

type Script = ConstructorParameters<typeof MockAdapter>[0]

/**
 * Drives the REAL spawn backend end-to-end: a real agent loop + a scripted mock
 * MODEL (the only mocked boundary) + the real SubagentService + the real
 * dsh-invariants plugin (so a malformed child session log would fail the test).
 * The parent is a real config agent; the spawn provider creates a real child
 * agent on the same context and we assert its output.
 */
async function setup(script: Script) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Invariants)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(AgentId('parent'), { model: 'mock' })
  return { ctx, parent, adapter }
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-subagent-spawn', () => {
  it('runs a fresh child to completion and returns its final assistant output', async () => {
    // One model call for the child: a plain text answer.
    const { ctx, parent } = await setup([textResponse('child answer')])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'do X' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child answer')
    await run.dispose()
  })

  it('gives the child its OWN session (not the parent\'s), with parentSession lineage', async () => {
    const { ctx, parent } = await setup([textResponse('hi')])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.id).not.toBe(parent.session.header.id)
    expect(child.session.header.parentSession).toBe(parent.session.header.id)
    await run.dispose()
  })

  it('a fresh child does NOT inherit the parent conversation (its log starts empty before the prompt)', async () => {
    // Drive the parent through one real turn so it has history, THEN spawn.
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('child sees nothing')])
    parent.send([{ type: 'text', text: 'parent prompt' }])
    await parent.whenIdle()
    const parentEventCount = parent.session.events.length
    expect(parentEventCount).toBeGreaterThan(0)

    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'child prompt' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    // The child's first user/message is its OWN prompt, not the parent's history.
    const firstUser = child.session.events.find(e => e.type === 'user/message')
    expect(firstUser).toBeDefined()
    await run.dispose()
  })

  it('disposes the child to quiescence (agent removed from the registry)', async () => {
    const { ctx, parent } = await setup([textResponse('x')])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await run.result
    expect(ctx.agents.get(run.id)).toBeDefined()
    await run.dispose()
    // After dispose, the child is unregistered (the AgentHandle teardown ran).
    expect(ctx.agents.get(run.id)).toBeUndefined()
  })

  it('stamps child depth = parent depth + 1 (via the merged AgentOptions field)', async () => {
    const { ctx, parent } = await setup([textResponse('x')])
    expect(depthOf(parent)).toBe(0)
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(depthOf(child)).toBe(1)
    await run.dispose()
  })

  it('refuses to spawn past maxDepth (depthLimit capability)', async () => {
    const { ctx, parent } = await setup([])
    // parent is depth 0, child would be depth 1 — cap at 0 forbids any child.
    expect(() => ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent, maxDepth: 0 }))
      .toThrow(SubagentDepthError)
  })

  it('maps a child that hit its token ceiling to stopReason "max-tokens"', async () => {
    const { ctx, parent } = await setup([maxTokensResponse('cut off')])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    await run.dispose()
  })

  it('maps a child whose turn errored (script exhausted) to stopReason "error" with empty output', async () => {
    // Empty script: the child's first model call throws "script exhausted", the
    // turn ends `error`, and there is no assistant/message → empty output.
    const { ctx, parent } = await setup([])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([])
    await run.dispose()
  })

  it('settles aborted (without running the child) when the request signal is ALREADY aborted', async () => {
    // Regression: a signal aborted BEFORE the run starts never fires an `abort`
    // event, so the listener can't catch it. The driver must check the
    // already-aborted case up front and settle `aborted` without running the
    // child — otherwise an already-cancelled request runs to `completed`. The
    // empty script proves the child's model is never called.
    const controller = new AbortController()
    controller.abort()
    const { ctx, parent } = await setup([])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent, signal: controller.signal })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.output).toEqual([])
    await run.dispose()
  })

  it('cancelling BEFORE the child turn starts settles aborted, not error', async () => {
    // Regression: a cancel landing in the pre-turn window clears the queued
    // prompt before any `turn/end` is logged. Deriving the stop reason from
    // `turn/end` alone then mis-maps the no-turn case to `error`; the run must
    // honor the cancel contract and settle `aborted`. The cancel is synchronous
    // (same tick as start, before the loop's queued-wait continuation runs), so
    // the turn is dropped and the empty script is never consumed.
    const { ctx, parent } = await setup([])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    run.cancel('early')
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.output).toEqual([])
    await run.dispose()
  })

  it('cancelling a running child settles the run as aborted (the abort bridge + cancel())', async () => {
    // 'hang' makes the child's model stream one chunk then wait until aborted.
    const controller = new AbortController()
    const { ctx, parent } = await setup(['hang'])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent, signal: controller.signal })
    // Let the child's turn start, then abort via the request signal (the
    // backend bridges it to child.cancel()).
    await new Promise(r => setTimeout(r, 30))
    controller.abort()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it('run.cancel() also cancels the child directly', async () => {
    const { ctx, parent } = await setup(['hang'])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await new Promise(r => setTimeout(r, 30))
    run.cancel('test cancel')
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it('run.cancel() with no reason uses the default cancel reason', async () => {
    const { ctx, parent } = await setup(['hang'])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    await new Promise(r => setTimeout(r, 30))
    run.cancel()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it('does not expose the optional runtime methods (sendMessage/resume) in this cut', async () => {
    const { ctx, parent } = await setup([textResponse('x')])
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent })
    expect('sendMessage' in run).toBe(false)
    expect('resume' in run).toBe(false)
    await run.result
    await run.dispose()
  })

  it('inherits the parent cwd into the child session', async () => {
    const { ctx } = await setup([textResponse('x')])
    // A parent WITH a cwd (config agents have none, so create one explicitly).
    const parentHandle = ctx.agents.create({
      agentId: AgentId('cwd-parent'),
      sessionId: SessionId('cwd-parent-session'),
      meta: { cwd: '/tmp/parent-workspace' },
      agentOptions: { model: 'mock' },
    })
    const run = ctx.subagents.start('spawn', { prompt: [{ type: 'text', text: 'p' }], parent: parentHandle.agent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.cwd).toBe('/tmp/parent-workspace')
    await run.dispose()
    await parentHandle.dispose()
  })

  it('uses request.agentOptions.model when the parent has no model of its own', async () => {
    const { ctx } = await setup([textResponse('explicit model child')])
    // A parent with NO model (its own turns would need one supplied per-request).
    const parentHandle = ctx.agents.create({
      agentId: AgentId('modelless-parent'),
      sessionId: SessionId('modelless-parent-session'),
      agentOptions: {},
    })
    // The request supplies the child's model explicitly.
    const run = ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'p' }],
      parent: parentHandle.agent,
      agentOptions: { model: 'mock' },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('explicit model child')
    await run.dispose()
    await parentHandle.dispose()
  })

  it('advertises depthLimit and outputSchema but not toolFilter', async () => {
    const { ctx } = await setup([])
    const provider = ctx.subagents.getProvider('spawn')!
    expect(provider.capabilities).toEqual({ outputSchema: true, depthLimit: true, toolFilter: false })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(spawn, { providerName: 'spawn' })
    expect(ctx.subagents.list()).toEqual(['spawn'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('captures structured output through the shipped plugin (driver runtime, plugin wiring)', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 42 }),
    ])
    const run = ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'produce the answer' }],
      parent,
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 42 })
    // Run-scoped runtime: the settle released the last acquisition.
    expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    await run.dispose()
  })

  it('a backend unload mid-structured-run settles the run and releases the runtime', async () => {
    // Rebuild the stack by hand so we hold the backend's fiber.
    const ctx = new Context()
    const adapter = new MockAdapter(['hang'])
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(Invariants)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const fiber = await ctx.plugin(spawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(AgentId('parent'), { model: 'mock' })
    const run = ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'q' }],
      parent,
      outputSchema: { type: 'object', properties: { a: { type: 'number' } } },
    })
    // Let the child's step start streaming, then unload the backend. The
    // backend owns the child agent, so the unload tears the child down and
    // the run settles — releasing its own runtime acquisition on the way out.
    await new Promise(resolve => setTimeout(resolve, 30))
    await fiber.dispose()
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    await run.dispose()
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in spawn).toBe(false)
    expect(spawn.name).toBe('subagent-spawn')
    expect(spawn.inject).toEqual(['subagents', 'agents'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(spawn) as Record<string, unknown>
    expect(unwrapped).toBe(spawn)
    expect(unwrapped.name).toBe('subagent-spawn')
    expect(unwrapped.inject).toEqual(['subagents', 'agents'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
