/**
 * Structured-output support for the in-process subagent backends: the mechanism
 * behind `SubagentStartRequest.outputSchema` for children that run as agents on
 * the same context.
 *
 * The model-facing surface is one globally registered `structured_output` tool
 * whose REGISTERED parameters are a placeholder — the real schema is per run.
 * Because the tool registry and prompt assembly are context-global while
 * schemas differ per child (two concurrent structured runs may carry different
 * schemas), per-agent shaping happens on the `agent/request` waterfall with a
 * `prepend: true` listener that post-processes `await next()` — FINAL-REQUEST
 * enforcement: whatever downstream listeners mutated or replaced, the request
 * that hits the wire never carries `structured_output` for an agent without a
 * structured run, and always carries the run's OWN schema for one that has it.
 * (Cooperative mutate-then-`next()` would not survive a downstream listener
 * returning a replacement request — see the waterfall composition caveat in
 * docs/architecture.md.)
 *
 * A companion `agent/turn-continuation` listener stops a child's turn once its
 * output is captured — without it, the loop's default "had tool calls ⇒
 * continue" buys a wasted extra model step per structured child.
 *
 * Lifetime is refcounted with two kinds of holder: each backend acquires for
 * its plugin lifetime (so the tool exists before any run), and each structured
 * RUN acquires from start to settle (so a backend hot-reload mid-run cannot
 * unregister the capture tool out from under a live child). Registrations are
 * effects on the ROOT context — their natural upper bound is app teardown — and
 * the refcount disposes them when the last holder releases.
 *
 * @module @deepseek-ai/dsh-subagent-inprocess/structured
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ContinuationDecision } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolArgsError, validateStructuredValue, type StructuredOutputSchema } from '@deepseek-ai/dsh-tools'

/** The model-facing tool name a structured child must call to finish. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/** The per-child instruction appended to a structured child's system prompt. */
export const STRUCTURED_OUTPUT_INSTRUCTION
  = 'When you have your final answer, you MUST report it by calling the '
    + `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only the tool call counts as your result.'

/** The nudge sent when a structured child finishes cleanly without calling the tool. */
export const STRUCTURED_OUTPUT_NUDGE
  = `You finished without calling \`${STRUCTURED_OUTPUT_TOOL}\`. `
    + `Call \`${STRUCTURED_OUTPUT_TOOL}\` now with your final result matching its parameter schema.`

/** One structured run's state: the schema to enforce and the captured value, once recorded. */
interface RunState {
  readonly schema: StructuredOutputSchema
  captured?: { value: unknown }
}

/** The per-root-context runtime: run states plus the shared registrations. */
interface StructuredRuntime {
  refs: number
  readonly states: WeakMap<Agent, RunState>
  readonly disposers: (() => void)[]
}

/** One root context ⇒ one runtime (multi-app test isolation). */
const runtimes = new WeakMap<Context, StructuredRuntime>()

/**
 * One holder's handle on the shared structured runtime. `release()` is
 * idempotent per acquisition; the runtime's registrations are disposed when the
 * LAST holder (backend plugin or live run) releases.
 */
export interface StructuredAcquisition {
  /** Enforce `schema` on `agent`'s requests and start capturing its `structured_output` call. */
  attach(agent: Agent, schema: StructuredOutputSchema): void
  /** The captured value, once the child called the tool with valid arguments. */
  captured(agent: Agent): { value: unknown } | undefined
  /** Stop enforcing/capturing for `agent` (WeakMap-backed; safe to call twice). */
  detach(agent: Agent): void
  /** Drop this holder's reference (idempotent); the last release unregisters everything. */
  release(): void
}

/**
 * Acquire the per-root-context structured runtime, registering the capture tool
 * and the two waterfall listeners on the FIRST acquisition. See the module doc
 * for the enforcement and lifetime design.
 * @param ctx - any context of the app; the runtime keys off `ctx.root`.
 * @returns this holder's handle (attach/captured/detach + idempotent release).
 */
export function acquireStructuredRuntime(ctx: Context): StructuredAcquisition {
  const root: Context = ctx.root
  let runtime = runtimes.get(root)
  if (!runtime) {
    runtime = { refs: 0, states: new WeakMap(), disposers: [] }
    runtimes.set(root, runtime)
    registerRuntime(root, runtime)
  }
  runtime.refs += 1

  let released = false
  return {
    attach(agent: Agent, schema: StructuredOutputSchema): void {
      runtime.states.set(agent, { schema })
    },
    captured(agent: Agent): { value: unknown } | undefined {
      return runtime.states.get(agent)?.captured
    },
    detach(agent: Agent): void {
      runtime.states.delete(agent)
    },
    release(): void {
      if (released) return
      released = true
      runtime.refs -= 1
      if (runtime.refs > 0) return
      runtimes.delete(root)
      for (const dispose of runtime.disposers.splice(0)) dispose()
    },
  }
}

/** Register the capture tool + the two listeners on the root context (first acquire). */
function registerRuntime(root: Context, runtime: StructuredRuntime): void {
  // The registered parameters are a PLACEHOLDER: the request listener below
  // swaps in the run's real schema per child, and strips the tool entirely for
  // every agent without a structured run — so this shape is never model-visible.
  runtime.disposers.push(root.tools.register({
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    parameters: { type: 'object', properties: {} },
    execute(args: unknown, exec: ToolExecution): Promise<ContentBlock[]> {
      const state = exec.agent ? runtime.states.get(exec.agent) : undefined
      if (!state) {
        // Reachable only if a non-structured agent somehow calls the tool (the
        // request listener strips it, so the model never sees it) — fail loud
        // rather than capture into nowhere.
        throw new Error(`${STRUCTURED_OUTPUT_TOOL} is only available to subagents started with an output schema`)
      }
      const violations = validateStructuredValue(state.schema, args)
      // ToolArgsError → isError result with INVALID_ARGS: the model retries
      // within the same turn, exactly like a schema-validated defineTool call.
      if (violations.length > 0) throw new ToolArgsError(violations)
      state.captured = { value: args }
      return Promise.resolve([{ type: 'text', text: 'Structured output recorded.' }])
    },
  }))

  // FINAL-REQUEST enforcement (prepend: true = first registered = OUTERMOST
  // wrapper): post-process whatever the downstream listeners and the core
  // produced, so a downstream listener returning a replacement request cannot
  // leak the tool to other agents or erase the child's schema.
  runtime.disposers.push(root.on('agent/request', async function (
    this: unknown, agent: Agent, _turn: number, _step: number, _options: GenerateOptions, next: () => Promise<GenerateOptions>,
  ): Promise<GenerateOptions> {
    const final = await next()
    const state = runtime.states.get(agent)
    if (state) {
      const schemaEntry: ToolSchema = {
        name: STRUCTURED_OUTPUT_TOOL,
        description:
          'Report your final structured result. Call this exactly once, when your answer is complete; '
          + 'the arguments must match this tool\'s parameter schema exactly.',
        // ToolSchema.parameters is the wire-level JSON Schema object; the
        // asserted subset type is structurally exactly that.
        parameters: state.schema as unknown as Record<string, unknown>,
      }
      final.tools = [...(final.tools ?? []).filter(tool => tool.name !== STRUCTURED_OUTPUT_TOOL), schemaEntry]
      return final
    }
    // No structured run: strip the placeholder if present; leave an absent
    // tools field absent (an adapter may treat `tools: []` and no tools
    // differently on the wire).
    if (final.tools?.some(tool => tool.name === STRUCTURED_OUTPUT_TOOL)) {
      final.tools = final.tools.filter(tool => tool.name !== STRUCTURED_OUTPUT_TOOL)
    }
    return final
  }, { prepend: true }))

  // Stop a structured child's turn once its output is captured: the default
  // "had tool calls ⇒ continue" would otherwise buy a wasted extra model step
  // after every successful capture.
  runtime.disposers.push(root.on('agent/turn-continuation', function (
    this: unknown, agent: Agent, _turn: number, _decision: ContinuationDecision, next: () => Promise<ContinuationDecision>,
  ): Promise<ContinuationDecision> {
    if (runtime.states.get(agent)?.captured) return Promise.resolve({ action: 'stop' })
    return next()
  }))
}
