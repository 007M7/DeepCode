import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import type { Agent, ContinuationDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import SubagentService, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { StructuredOutputSchema } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn'
import * as fork from '@deepseek-ai/dsh-subagent-fork'
import {
  acquireStructuredRuntime,
  STRUCTURED_OUTPUT_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL,
} from '../src/structured.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const SCHEMA: StructuredOutputSchema = {
  type: 'object',
  properties: { answer: { type: 'number' }, note: { type: 'string' } },
  required: ['answer'],
}

/**
 * Real loop + scripted mock model + the REAL spawn backend (which acquires the
 * structured runtime at apply, exactly as shipped). The mock model script
 * drives the child's structured_output calls.
 */
async function setup(script: Script, options?: { nudges?: number; withFork?: boolean }) {
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
  const fiber = await ctx.plugin(spawn, { providerName: 'spawn', structuredNudgeRetries: options?.nudges ?? 1 })
  const forkFiber = options?.withFork
    ? await ctx.plugin(fork, { providerName: 'fork', structuredNudgeRetries: options?.nudges ?? 1 })
    : undefined
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(AgentId('parent'), { model: 'mock' })
  return { ctx, parent, adapter, fiber, forkFiber }
}

function structuredRequest(parent: SubagentStartRequest['parent'], extra?: Partial<SubagentStartRequest>): SubagentStartRequest {
  return { prompt: [{ type: 'text', text: 'produce the answer' }], parent, outputSchema: SCHEMA, ...extra }
}

/** The tool names of one recorded model request. */
function toolNames(request: GenerateOptions): string[] {
  return (request.tools ?? []).map(tool => tool.name)
}

describe('in-process structured output', () => {
  it('captures a valid structured_output call and surfaces result.structured', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 42, note: 'done' }),
    ])
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 42, note: 'done' })
    await run.dispose()
  })

  it('stops the turn after a successful capture — no extra model step is spent', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
      textResponse('MUST NOT BE CONSUMED'),
    ])
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    await run.result
    // Default continuation would run a second step after the tool call; the
    // structured runtime's turn-continuation veto stops the turn instead.
    expect(adapter.requests.length).toBe(1)
    await run.dispose()
  })

  it('the captured-turn veto is prepend: an EARLIER force-continue listener cannot short-circuit it', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    // Registered BEFORE the structured runtime exists — without prepend, this
    // goal-style listener would decide the turn first (returning WITHOUT
    // calling next()) and the veto would never run.
    ctx.on('agent/turn-continuation', () => Promise.resolve<ContinuationDecision>({ action: 'continue' }))
    const acquisition = acquireStructuredRuntime(ctx)
    const agent = { id: AgentId('structured-child') } as unknown as Agent
    acquisition.attach(agent, SCHEMA)
    const captured = await ctx.tools.execute({
      callId: 'call-1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
      agent,
    })
    expect(captured.isError).toBeFalsy()
    const decision = await ctx.waterfall(
      'agent/turn-continuation', agent, 1,
      { action: 'continue' },
      () => Promise.resolve<ContinuationDecision>({ action: 'continue' }),
    )
    expect(decision).toEqual({ action: 'stop' })
    acquisition.detach(agent)
    acquisition.release()
  })

  it('an invalid call gets an INVALID_ARGS isError result and the model retries in-turn', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 'not-a-number' }),
      toolCallResponse('c2', STRUCTURED_OUTPUT_TOOL, { answer: 7 }),
    ])
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.structured).toEqual({ answer: 7 })
    expect(result.stopReason).toBe('completed')
    // The child's log carries the isError tool/result for the invalid call.
    const child = ctx.agents.get(run.id)!
    const results = child.session.events.filter(e => e.type === 'tool/result')
    expect(results.length).toBe(2)
    expect((results[0]!.data as { isError?: boolean }).isError).toBe(true)
    await run.dispose()
  })

  it('nudges a child that finished cleanly without calling the tool, then captures', async () => {
    const { ctx, parent } = await setup([
      textResponse('here is my answer in prose'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 3 }),
    ])
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.structured).toEqual({ answer: 3 })
    expect(result.stopReason).toBe('completed')
    // The nudge is a real user-visible message in the child's log.
    const child = ctx.agents.get(run.id)!
    const users = child.session.events.filter(e => e.type === 'user/message')
    expect(users.length).toBe(2)
    await run.dispose()
  })

  it('settles error when the nudges run out without a capture', async () => {
    const { ctx, parent, adapter } = await setup([
      textResponse('prose only'),
      textResponse('still prose'),
    ], { nudges: 1 })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.structured).toBeUndefined()
    expect(adapter.requests.length).toBe(2)
    await run.dispose()
  })

  it('zero nudge retries fails immediately after the first clean prose finish', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('prose')], { nudges: 0 })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(adapter.requests.length).toBe(1)
    await run.dispose()
  })

  it('a child that errored is NOT nudged (its failure is the honest result)', async () => {
    // Script exhaustion on the first call → the child turn errors.
    const { ctx, parent, adapter } = await setup([], { nudges: 3 })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(adapter.requests.length).toBe(1)
    await run.dispose()
  })

  it('a cancel landing after a clean turn end stops the nudge loop: no post-cancellation turn is spent', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('prose, no capture')], { nudges: 3 })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const child = ctx.agents.get(run.id)!
    // Cancel synchronously inside the first turn's end recording — after the
    // turn reads `completed`, before the nudge continuation resumes. The turn
    // state alone cannot see this cancel (`child.cancel()` only clears
    // queued/running work), so without the loop's own cancelled check the
    // next send would spend a fresh child turn after the caller cancelled.
    ctx.on('session/event', (session, event) => {
      if (session === child.session && event.type === 'turn/end') run.cancel('cancelled between turn end and nudge')
    })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    // Exactly one model request: the nudge turn never ran.
    expect(adapter.requests.length).toBe(1)
    await run.dispose()
  })

  it('rejects a schema outside the subset loud, before any child exists', async () => {
    const { ctx, parent } = await setup([])
    expect(() => ctx.subagents.start('spawn', structuredRequest(parent, {
      outputSchema: { type: 'object', oneOf: [] } as unknown as StructuredOutputSchema,
    }))).toThrow(/unsupported output schema/)
    expect(ctx.agents.get(AgentId('parent'))).toBeDefined()
  })

  it('appends the structured instruction to the child REQUEST\'s system text (base prompt preserved)', async () => {
    const { ctx, parent, adapter } = await setup([toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 })])
    // A context-wide section stands in for the deployment persona: the
    // instruction must APPEND to whatever the prompt pipeline assembled, not
    // replace it (AgentOptions has no prompt field — the instruction is
    // per-request wire state added by the final-request listener).
    ctx.systemPrompt.section({ name: 'test:persona', order: 10, text: 'You are a counter.' })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    await run.result
    const childRequest = adapter.requests.at(-1)!
    expect(childRequest.system).toContain('You are a counter.')
    expect(childRequest.system!.endsWith(STRUCTURED_OUTPUT_INSTRUCTION)).toBe(true)
    expect(childRequest.system!.indexOf(STRUCTURED_OUTPUT_INSTRUCTION)).toBeGreaterThan(0)
    await run.dispose()
  })

  it('the instruction rides ONLY structured requests: appended for the child, absent for a plain agent', async () => {
    const { ctx, parent, adapter } = await setup([
      textResponse('parent answer'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
    ])
    parent.send([{ type: 'text', text: 'hello' }])
    await parent.whenIdle()
    expect(adapter.requests[0]!.system ?? '').not.toContain(STRUCTURED_OUTPUT_INSTRUCTION)
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    await run.result
    // The loop always assembles a base prompt (the harness identity section),
    // so the instruction APPENDS — never replaces.
    const childSystem = adapter.requests.at(-1)!.system!
    expect(childSystem.endsWith(STRUCTURED_OUTPUT_INSTRUCTION)).toBe(true)
    expect(childSystem.length).toBeGreaterThan(STRUCTURED_OUTPUT_INSTRUCTION.length)
    await run.dispose()
  })

  describe('final-request enforcement (the prepend agent/request listener)', () => {
    it('a structured child sees structured_output with ITS schema; a plain agent never sees the tool', async () => {
      const { ctx, parent, adapter } = await setup([
        // Parent turn (a plain agent): must NOT see the tool.
        textResponse('parent answer'),
        // Child turn: must see it, with the run's schema.
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 42 }),
      ])
      parent.send([{ type: 'text', text: 'hello' }])
      await parent.whenIdle()
      expect(toolNames(adapter.requests[0]!)).not.toContain(STRUCTURED_OUTPUT_TOOL)

      const run = ctx.subagents.start('spawn', structuredRequest(parent))
      await run.result
      const childRequest = adapter.requests[1]!
      expect(toolNames(childRequest)).toContain(STRUCTURED_OUTPUT_TOOL)
      const entry = childRequest.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!
      expect(entry.parameters).toEqual(SCHEMA)
      await run.dispose()
    })

    it('two concurrent structured children each see their OWN schema', async () => {
      const otherSchema: StructuredOutputSchema = {
        type: 'object',
        properties: { verdict: { type: 'string', enum: ['real', 'bogus'] } },
        required: ['verdict'],
      }
      const { ctx, parent, adapter } = await setup([
        (options: GenerateOptions) => {
          // Answer with whatever schema this child was given — proves each
          // request carried the right one regardless of scheduling order.
          const entry = options.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!
          const args = 'verdict' in (entry.parameters.properties as Record<string, unknown>)
            ? { verdict: 'real' }
            : { answer: 1 }
          return toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, args)
        },
        (options: GenerateOptions) => {
          const entry = options.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!
          const args = 'verdict' in (entry.parameters.properties as Record<string, unknown>)
            ? { verdict: 'real' }
            : { answer: 1 }
          return toolCallResponse('c2', STRUCTURED_OUTPUT_TOOL, args)
        },
      ])
      const runA = ctx.subagents.start('spawn', structuredRequest(parent))
      const runB = ctx.subagents.start('spawn', structuredRequest(parent, { outputSchema: otherSchema }))
      const [a, b] = await Promise.all([runA.result, runB.result])
      expect(a.structured).toEqual({ answer: 1 })
      expect(b.structured).toEqual({ verdict: 'real' })
      const schemas = adapter.requests.map(request =>
        request.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!.parameters)
      expect(schemas).toContainEqual(SCHEMA)
      expect(schemas).toContainEqual(otherSchema)
      await runA.dispose()
      await runB.dispose()
    })

    it('wins against a downstream listener that REPLACES the request object', async () => {
      const { ctx, parent, adapter } = await setup([
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 5 }),
      ])
      // A downstream (non-prepend) listener that returns a brand-new request —
      // the composition caveat that erases cooperative mutations. Registered
      // AFTER the runtime's prepend listener, so it runs INSIDE it.
      ctx.on('agent/request', async (_agent, _turn, _step, _options, next) => {
        const replaced = await next()
        return { ...replaced, tools: [...(replaced.tools ?? [])] }
      })
      const run = ctx.subagents.start('spawn', structuredRequest(parent))
      const result = await run.result
      expect(result.structured).toEqual({ answer: 5 })
      const entry = adapter.requests[0]!.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)
      expect(entry).toBeDefined()
      expect(entry!.parameters).toEqual(SCHEMA)
      await run.dispose()
    })

    it('a non-structured agent request keeps tools ABSENT when it had none (no tools: [] materialized)', async () => {
      const { parent, adapter } = await setup([
        // The registry contributes the placeholder via prompt assembly, so
        // tools is an array in the raw request — but after stripping the
        // placeholder (its ONLY entry), the field must not be re-added as a
        // different shape.
        textResponse('plain'),
      ])
      parent.send([{ type: 'text', text: 'q' }])
      await parent.whenIdle()
      const request = adapter.requests[0]!
      expect(toolNames(request)).not.toContain(STRUCTURED_OUTPUT_TOOL)
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    it('handles a request with NO tools field at all, for plain and structured agents alike', async () => {
      // Drive the waterfall directly with a toolless request — the enforcement
      // listener must tolerate `tools: undefined` on both branches: leave it
      // absent for a plain agent, and create the array for a structured child.
      const { ctx, parent } = await setup([])
      const bare: GenerateOptions = { model: 'mock', messages: [] }
      const plain = await ctx.waterfall('agent/request', parent, 1, 1, bare, () => Promise.resolve(bare))
      expect(plain.tools).toBeUndefined()

      const acquisition = acquireStructuredRuntime(ctx)
      acquisition.attach(parent, SCHEMA)
      const bare2: GenerateOptions = { model: 'mock', messages: [] }
      const shaped = await ctx.waterfall('agent/request', parent, 1, 1, bare2, () => Promise.resolve(bare2))
      expect(shaped.tools!.map(tool => tool.name)).toEqual([STRUCTURED_OUTPUT_TOOL])
      // A bare request carries no system text: the instruction IS the system.
      expect(shaped.system).toBe(STRUCTURED_OUTPUT_INSTRUCTION)
      acquisition.detach(parent)
      acquisition.release()
    })
  })

  describe('runtime lifetime (refcount: backends + live runs)', () => {
    it('registers the capture tool while a backend is loaded and unregisters when the last unloads', async () => {
      const { ctx, fiber, forkFiber } = await setup([], { withFork: true })
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeDefined()
      await fiber.dispose()
      // fork still holds a reference.
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeDefined()
      await forkFiber!.dispose()
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    })

    it('a live run-level acquisition keeps the runtime registered after EVERY backend unloads', async () => {
      // Simulates the run-holder half of the two-level lifetime: a structured
      // run acquires at start and releases at settle, so registration ordering
      // is settle-then-unregister even if all backends unload first. (A real
      // in-process child dies WITH its backend's fiber — the acquisition's
      // observable job is this ordering, which a manual holder pins directly.)
      const { ctx, fiber, forkFiber } = await setup([], { withFork: true })
      const runHolder = acquireStructuredRuntime(ctx)
      await fiber.dispose()
      await forkFiber!.dispose()
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeDefined()
      runHolder.release()
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    })

    it('a structured run releases its acquisition when it settles (backend unload mid-run)', async () => {
      const { ctx, parent, fiber } = await setup(['hang'])
      const run = ctx.subagents.start('spawn', structuredRequest(parent))
      // Let the child's step start streaming, then unload the backend. The
      // backend owns the child agent, so the unload tears the child down and
      // the run settles — releasing its own acquisition on the way out.
      await new Promise(resolve => setTimeout(resolve, 30))
      await fiber.dispose()
      const result = await run.result
      expect(result.stopReason).toBe('error')
      // Both holders (backend + run) released — nothing keeps the runtime now.
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
      await run.dispose()
    })

    it('fork children capture structured output through the same runtime', async () => {
      const { ctx, parent } = await setup([
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 9 }),
      ], { withFork: true })
      const run = ctx.subagents.start('fork', structuredRequest(parent))
      const result = await run.result
      expect(result.structured).toEqual({ answer: 9 })
      await run.dispose()
    })

    it('acquisition release is idempotent (double release cannot underflow the refcount)', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      const first = acquireStructuredRuntime(ctx)
      const second = acquireStructuredRuntime(ctx)
      first.release()
      first.release()
      // The second holder still keeps the tool registered.
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeDefined()
      second.release()
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    })

    it('attach/captured/detach manage per-agent state through the acquisition surface', async () => {
      const { ctx, parent } = await setup([])
      const acquisition = acquireStructuredRuntime(ctx)
      expect(acquisition.captured(parent)).toBeUndefined()
      acquisition.attach(parent, SCHEMA)
      expect(acquisition.captured(parent)).toBeUndefined()
      acquisition.detach(parent)
      acquisition.detach(parent)
      acquisition.release()
      // The backend still holds its own reference from setup().
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeDefined()
    })
  })

  it('a direct structured_output call from an agent WITHOUT a structured run is an isError', async () => {
    const { ctx, parent } = await setup([])
    const result = await ctx.tools.execute({
      callId: 'x' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
      agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
  })

  it('a structured_output call with NO calling agent at all is an isError', async () => {
    const { ctx } = await setup([])
    const result = await ctx.tools.execute({
      callId: 'x' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
    })
    expect(result.isError).toBe(true)
  })
})
