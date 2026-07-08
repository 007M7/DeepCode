import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
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
import { startInProcessRun } from '../src/index.ts'
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
 * Real loop + scripted mock model + an INLINE spawn-shaped provider over the
 * shared driver. The concrete backend plugins are deliberately NOT loaded —
 * they would devDep-cycle this package (spawn/fork already depend on the
 * driver), and the runtime under test is the driver's; plugin-level structured
 * coverage lives in the spawn/fork specs. The mock model script drives the
 * child's structured_output calls.
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
  const disposeProvider = ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: false },
    inheritsParentContext: false,
    start: (request: SubagentStartRequest) => startInProcessRun(ctx, request, { providerName: 'spawn' }),
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(AgentId('parent'), { model: 'mock' })
  return { ctx, parent, adapter, disposeProvider }
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

  it('denies tool calls that FOLLOW the capture in the same response — terminal means terminal', async () => {
    // One model response carrying structured_output FIRST and a side-effecting
    // call after it: the continuation veto only fires at step end, so without
    // the pre-execute deny the trailing call would still run after the final
    // answer was accepted.
    const response = [
      ...toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 5 }).slice(0, -2),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('c2'), name: 'side_effect', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] as Script[number]
    const { ctx, parent } = await setup([response])
    let sideEffectRan = false
    ctx.tools.register({
      name: 'side_effect',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute(): Promise<ContentBlock[]> {
        sideEffectRan = true
        return Promise.resolve([{ type: 'text', text: 'ran' }])
      },
    })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 5 })
    // The deny skipped dispatch entirely: the probe body never ran.
    expect(sideEffectRan).toBe(false)
    await run.dispose()
  })

  it('leaves tool calls that PRECEDE the capture in the same response untouched', async () => {
    const response = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c1'), name: 'side_effect', arguments: '{}' } },
      ...toolCallResponse('c2', STRUCTURED_OUTPUT_TOOL, { answer: 6 }).map(chunk =>
        'index' in chunk ? { ...chunk, index: 1 } : chunk),
    ] as Script[number]
    const { ctx, parent } = await setup([response])
    let sideEffectRan = false
    ctx.tools.register({
      name: 'side_effect',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute(): Promise<ContentBlock[]> {
        sideEffectRan = true
        return Promise.resolve([{ type: 'text', text: 'ran' }])
      },
    })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    // The call ran BEFORE captured was set: the deny gate only guards the
    // window after the terminal answer landed.
    expect(sideEffectRan).toBe(true)
    expect(result.structured).toEqual({ answer: 6 })
    await run.dispose()
  })

  it('snapshots the schema at start(): caller mutation after start cannot drift enforcement', async () => {
    const mutable: StructuredOutputSchema = {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
      additionalProperties: false,
    }
    const pristine = structuredClone(mutable)
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 3 }),
    ])
    const run = ctx.subagents.start('spawn', structuredRequest(parent, { outputSchema: mutable }))
    // Mutate the caller's object AFTER start() returned but before the child's
    // first request assembles: with a live reference this would reach both the
    // model-visible parameters and validateStructuredValue.
    ;(mutable.properties as Record<string, unknown>).answer = { type: 'string' }
    const result = await run.result
    expect(result.structured).toEqual({ answer: 3 })
    // The child's request carried the PRISTINE schema, not the mutated one.
    const childRequest = adapter.requests.at(-1)
    const captureTool = (childRequest?.tools ?? []).find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)
    expect(captureTool?.parameters).toEqual(pristine)
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

  it('a clean finish without a capture is an immediate error to the parent — deliberately NO re-prompt', async () => {
    const { ctx, parent, adapter } = await setup([
      textResponse('here is my answer in prose'),
      textResponse('MUST NOT BE CONSUMED'),
    ])
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.structured).toBeUndefined()
    // Exactly one model request and one user message: no nudge turn exists.
    expect(adapter.requests.length).toBe(1)
    const child = ctx.agents.get(run.id)!
    expect(child.session.events.filter(e => e.type === 'user/message').length).toBe(1)
    await run.dispose()
  })

  it('an errored child keeps its honest error result (no capture expected)', async () => {
    // Script exhaustion on the first call → the child turn errors.
    const { ctx, parent, adapter } = await setup([])
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(adapter.requests.length).toBe(1)
    await run.dispose()
  })

  it('a cancel landing after a clean capture-less turn settles aborted, not error', async () => {
    const { ctx, parent } = await setup([textResponse('prose, no capture')])
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const child = ctx.agents.get(run.id)!
    // Cancel synchronously inside the turn's end recording: the cancel
    // contract outranks the schema shortfall, so the result maps to aborted.
    ctx.on('session/event', (session, event) => {
      if (session === child.session && event.type === 'turn/end') run.cancel('cancelled at turn end')
    })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it('rejects a schema outside the subset loud, before any child exists', async () => {
    const { ctx, parent } = await setup([])
    expect(() => ctx.subagents.start('spawn', structuredRequest(parent, {
      outputSchema: { type: 'object', oneOf: [] } as unknown as StructuredOutputSchema,
    }))).toThrow(/unsupported output schema/)
    expect(ctx.agents.get(AgentId('parent'))).toBeDefined()
  })

  it('a schema carrying non-JSON values fails as OutputSchemaError, never as a raw clone error', async () => {
    const { ctx, parent } = await setup([])
    // Assertion runs BEFORE the defensive structuredClone: a function-valued
    // annotation must surface as the subset violation it is, not escape as
    // structuredClone's DataCloneError.
    expect(() => ctx.subagents.start('spawn', structuredRequest(parent, {
      outputSchema: { type: 'object', default: () => {} } as unknown as StructuredOutputSchema,
    }))).toThrow(/unsupported output schema.*annotation must be JSON data/)
  })

  it('a post-execute BLOCK on the capture call denies the capture: log and result agree on failure', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 7 }),
      textResponse('continues after the blocked capture'),
    ])
    // A PostToolUse-style hook, registered AFTER the runtime (so the runtime's
    // prepend commit listener stays outermost and composes this verdict).
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL) {
        return Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'capture rejected by hook' }] })
      }
      return next()
    })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    // No capture was committed: the run reports the schema shortfall...
    expect(result.structured).toBeUndefined()
    expect(result.stopReason).toBe('error')
    // ...the logged tool result is the blocked isError with the feedback...
    const child = ctx.agents.get(run.id)!
    const results = child.session.events.filter(e => e.type === 'tool/result')
    expect((results[0]!.data as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify((results[0]!.data as { content: unknown }).content)).toContain('capture rejected by hook')
    // ...and the turn CONTINUED past the blocked call (no captured veto):
    // the model got to react to the failure with a second step.
    expect(adapter.requests.length).toBe(2)
    await run.dispose()
  })

  it('a post-execute accept-with-replacement still commits the capture', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 8 }),
    ])
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL) {
        return Promise.resolve({ kind: 'accept' as const, content: [{ type: 'text' as const, text: 'recorded (rewritten)' }] })
      }
      return next()
    })
    const run = ctx.subagents.start('spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 8 })
    await run.dispose()
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
    it('a plain agent assembling while the runtime is LIVE gets the placeholder stripped', async () => {
      // Run-scoped acquisition means a plain deployment never registers the
      // tool at all; the strip branch exists for the CONCURRENT case — a plain
      // agent taking a turn while some structured child holds the runtime open.
      const { ctx, parent, adapter } = await setup([textResponse('parent answer')])
      const hold = acquireStructuredRuntime(ctx)
      parent.send([{ type: 'text', text: 'hello' }])
      await parent.whenIdle()
      // The placeholder IS in the registry during this turn; the assembly the
      // loop rendered must not carry it for an agent without a structured run.
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeDefined()
      expect(toolNames(adapter.requests[0]!)).not.toContain(STRUCTURED_OUTPUT_TOOL)
      hold.release()
    })

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

    it('wins against a downstream listener that REPLACES the assembly object', async () => {
      const { ctx, parent, adapter } = await setup([
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 5 }),
      ])
      // A downstream (non-prepend) listener that returns a brand-new assembly —
      // the composition caveat that erases cooperative mutations. Registered
      // AFTER the runtime's prepend listener, so it runs INSIDE it.
      ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const replaced = await next()
        return { sections: [...replaced.sections], tools: [...replaced.tools], variables: { ...replaced.variables } }
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

    it('shapes a bare assembly on the waterfall: no-agent context strips the placeholder; a structured agent gains schema + trailing instruction section', async () => {
      // Drive ctx.systemPrompt.assemble directly — the enforcement listener
      // must tolerate a context with NO agent (a bare diagnostic assemble)
      // and shape a structured agent's assembly on the same path the loop
      // renders and logs as the request header.
      const { ctx, parent } = await setup([])
      const acquisition = acquireStructuredRuntime(ctx)
      // Bare assemble WHILE the runtime is live: the no-agent branch must
      // strip the registered placeholder (before the acquisition there is
      // nothing to strip — run-scoped registration).
      const bare = await ctx.systemPrompt.assemble({})
      expect(bare.tools.map(tool => tool.name)).not.toContain(STRUCTURED_OUTPUT_TOOL)

      acquisition.attach(parent, SCHEMA)
      const shaped = await ctx.systemPrompt.assemble({ agent: parent })
      expect(shaped.tools.map(tool => tool.name)).toContain(STRUCTURED_OUTPUT_TOOL)
      expect(shaped.tools.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!.parameters).toEqual(SCHEMA)
      // The demand travels with the tool: the instruction renders LAST
      // (appended post-next(); renderPrompt joins in array order).
      expect(shaped.sections.at(-1)).toMatchObject({ name: `tool:${STRUCTURED_OUTPUT_TOOL}`, text: STRUCTURED_OUTPUT_INSTRUCTION })
      acquisition.detach(parent)
      acquisition.release()
    })
  })

  describe('runtime lifetime (refcount: live structured runs)', () => {
    it('the runtime exists exactly while structured runs are live: nothing before, nothing after', async () => {
      const { ctx, parent } = await setup([
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 4 }),
      ])
      // No always-on global state: a context that has run no structured child
      // carries no capture tool.
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
      const run = ctx.subagents.start('spawn', structuredRequest(parent))
      const result = await run.result
      // The capture succeeded — the registrations existed while the run lived.
      expect(result.structured).toEqual({ answer: 4 })
      // The run's settle released the last acquisition.
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
      await run.dispose()
    })

    it('concurrent structured runs share one runtime; the last settle disposes it', async () => {
      const { ctx, parent } = await setup([
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
        toolCallResponse('c2', STRUCTURED_OUTPUT_TOOL, { answer: 2 }),
      ])
      const first = ctx.subagents.start('spawn', structuredRequest(parent))
      const second = ctx.subagents.start('spawn', structuredRequest(parent))
      const [a, b] = await Promise.all([first.result, second.result])
      expect([a.structured, b.structured].sort()).toEqual([{ answer: 1 }, { answer: 2 }].sort())
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
      await first.dispose()
      await second.dispose()
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

    it('registers the capture tool through the scoped fiber when tools loads after the acquisition', async () => {
      // The Loader starts sibling plugins concurrently, so a backend can
      // acquire the runtime before dsh-tools has applied. The capture tool
      // must then register as soon as `tools` exists — via the inject fiber,
      // not by deferring the backend (which would reorder the prompt's tools).
      const ctx = new Context()
      const acquisition = acquireStructuredRuntime(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      // Fiber activation completes asynchronously after the service appears.
      await new Promise(resolve => setImmediate(resolve))
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeDefined()
      acquisition.release()
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    })

    it('releasing before tools ever loads disposes the pending fiber without registering', async () => {
      const ctx = new Context()
      const acquisition = acquireStructuredRuntime(ctx)
      acquisition.release()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await new Promise(resolve => setImmediate(resolve))
      // The disposed fiber never fires: nothing registers after the fact.
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
      // That manual acquisition was the ONLY holder - release disposes.
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    })
  })

  it('a direct structured_output call from an agent WITHOUT a structured run is an isError', async () => {
    const { ctx, parent } = await setup([])
    // Hold the runtime open (run-scoped: nothing is registered otherwise) so
    // the call reaches the capture tool's own fail-loud guard, not UNKNOWN_TOOL.
    const hold = acquireStructuredRuntime(ctx)
    const result = await ctx.tools.execute({
      callId: 'x' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
      agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('only available to subagents')
    hold.release()
  })

  it('a structured_output call with NO calling agent at all is an isError', async () => {
    const { ctx } = await setup([])
    const hold = acquireStructuredRuntime(ctx)
    const result = await ctx.tools.execute({
      callId: 'x' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
    })
    expect(result.isError).toBe(true)
    hold.release()
  })
})
