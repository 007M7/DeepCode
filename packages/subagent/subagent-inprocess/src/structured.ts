/**
 * Structured-output support for the in-process subagent backends: the
 * mechanism behind `SubagentStartRequest.outputSchema` for children that run
 * as agents on the same context.
 *
 * Everything is a SCOPED registration on the child agent's context
 * (`child.ctx`, the dsh-scope seam): the `structured_output` capture tool
 * carries the run's REAL schema as its registered parameters (each child sees
 * exactly its own schema — two concurrent structured runs never interact), the
 * demand instruction is an ordinary order-190 scoped section, and the
 * enforcement listeners fire only for this child (scope-filtered dispatch).
 * Registration lifetime rides the child's fiber, so a backend hot-reload
 * mid-run cannot unregister the capture tool out from under a live child, and
 * a disposed child leaves no residue — no placeholder schema, no
 * strip-for-everyone-else, no refcounted global runtime, no `WeakMap` state.
 *
 * Four listeners enforce the contract:
 *
 * - `system-prompt/assemble` (prepend, scoped): FINAL-ASSEMBLY re-assert —
 *   whatever downstream listeners mutated or replaced, the child's assembly
 *   always carries its capture tool and the trailing instruction section. The
 *   registry already contributes both; this outermost wrapper preserves the
 *   guarantee against a (global) listener that strips or replaces the
 *   assembly. The loop logs the rendered assembly as the request header, so
 *   the demand is reconstructable log state, never a wire-only mutation.
 * - `agent/turn-continuation` (prepend, scoped): stop the child's turn once
 *   its output is captured — the loop's default "had tool calls ⇒ continue"
 *   would buy a wasted extra model step per structured child.
 * - `tools/pre-execute` (prepend, scoped): terminal means terminal WITHIN the
 *   step — deny every call arriving after the capture, so a response that
 *   lists `structured_output` before further tool calls cannot run side
 *   effects after the final answer was accepted.
 * - `tools/post-execute` (prepend, scoped): the capture COMMIT. The tool body
 *   only STAGES the validated value, KEYED BY CALL ID; it becomes the run's
 *   captured result only when the final post-execute decision accepts THAT
 *   call. Call-keyed staging closes a stale-stage hole: an outer
 *   short-circuiting post-execute listener can orphan a staged value, and an
 *   un-keyed commit would then promote it on a LATER call's acceptance —
 *   reporting success for a value the model saw fail.
 *
 * @module @deepseek-ai/dsh-subagent-inprocess/structured
 */

import type { Context } from 'cordis'
import type { Agent, ContinuationDecision } from '@deepseek-ai/dsh-agent'
import type { CallId, ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolArgsError, validateStructuredValue, type StructuredOutputSchema } from '@deepseek-ai/dsh-tools'

/** The model-facing tool name a structured child must call to finish. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/**
 * The instruction registered as the child's trailing (order-190, the end of
 * the tool-guidance band) scoped prompt section: the demand travels with the
 * tool, as ordinary prompt state of exactly one agent.
 */
export const STRUCTURED_OUTPUT_INSTRUCTION
  = 'When you have your final answer, you MUST report it by calling the '
    + `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only the tool call counts as your result.'

/** One structured run's live handle: read the captured value once the child settles. */
export interface StructuredAttachment {
  /**
   * The captured value, once the child called the tool with valid arguments
   * and the final post-execute decision accepted that call.
   * @returns the committed value, or undefined while none was accepted.
   */
  captured(): { value: unknown } | undefined
}

/**
 * Attach the structured-output runtime to a child for `schema`: register the
 * scoped capture tool (real schema), the scoped instruction section, and the
 * four scoped enforcement listeners (see the module doc). Call from the
 * agent-creation `setup` window with the child's scope context — every
 * registration rides the child's fiber and unwinds with the child.
 * @param childCtx - the child agent's scope context (`setup`'s argument).
 * @param schema - the isolation-cloned, already-asserted schema subset to
 *   enforce (see `assertSupportedOutputSchema` in dsh-tools).
 * @returns the attachment handle (read `captured()` after the child settles).
 */
export function attachStructuredRuntime(childCtx: Context, schema: StructuredOutputSchema): StructuredAttachment {
  /** A validated value staged by the capture tool body, awaiting ITS OWN call's post-execute verdict. */
  let pending: { callId: CallId; value: unknown } | undefined
  let captured: { value: unknown } | undefined

  const schemaEntry: ToolSchema = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    // ToolSchema.parameters is the wire-level JSON Schema object; the
    // asserted subset type is structurally exactly that.
    parameters: schema as unknown as Record<string, unknown>,
  }

  childCtx.tools.register({
    ...schemaEntry,
    execute(args: unknown, exec: ToolExecution): Promise<ContentBlock[]> {
      const violations = validateStructuredValue(schema, args)
      // ToolArgsError → isError result with INVALID_ARGS: the model retries
      // within the same turn, exactly like a schema-validated defineTool call.
      if (violations.length > 0) throw new ToolArgsError(violations)
      // Two-phase commit, KEYED BY THIS CALL: the body only stages; the
      // post-execute listener promotes exactly this call's entry when the
      // final decision accepts it.
      pending = { callId: exec.callId, value: args }
      return Promise.resolve([{ type: 'text', text: 'Structured output recorded.' }])
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: 190,
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  })

  // FINAL-ASSEMBLY re-assert (prepend = outermost): scoped dispatch means this
  // fires only for the child's assemblies; `await next()` returns whatever the
  // downstream chain (and any replacement assembly) produced, and the capture
  // tool + instruction are re-asserted onto it if anything stripped them.
  childCtx.on('system-prompt/assemble', async function (
    this: unknown, _assembly: PromptAssembly, _context: AssembleContext, next: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly> {
    const final = await next()
    if (!final.tools.some(tool => tool.name === STRUCTURED_OUTPUT_TOOL)) {
      final.tools = [...final.tools, { ...schemaEntry, parameters: structuredClone(schemaEntry.parameters) }]
    }
    if (!final.sections.some(section => section.name === `tool:${STRUCTURED_OUTPUT_TOOL}`)) {
      final.sections = [...final.sections, { name: `tool:${STRUCTURED_OUTPUT_TOOL}`, order: 190, text: STRUCTURED_OUTPUT_INSTRUCTION }]
    }
    return final
  }, { prepend: true })

  // Stop the child's turn once its output is captured. `prepend: true` puts
  // the veto OUTERMOST — an earlier-registered listener that short-circuits
  // the chain (a goal-style force-continue returning without `next()`) would
  // otherwise decide the turn before this listener ever ran, and no
  // downstream decision may resurrect a structured turn that is finished.
  childCtx.on('agent/turn-continuation', function (
    this: unknown, _agent: Agent, _turn: number, _decision: ContinuationDecision, next: () => Promise<ContinuationDecision>,
  ): Promise<ContinuationDecision> {
    if (captured) return Promise.resolve({ action: 'stop' })
    return next()
  }, { prepend: true })

  // Terminal WITHIN the step: deny every call after the capture. Calls that
  // PRECEDE the capture in the same response ran before `captured` was set
  // and are untouched; a second `structured_output` is denied like any other.
  childCtx.on('tools/pre-execute', function (
    this: unknown, exec: ToolExecution, next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    if (captured) {
      return Promise.resolve({
        kind: 'deny',
        reason: `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`,
      })
    }
    return next()
  }, { prepend: true })

  // The capture COMMIT: promote the staged value only when the final
  // post-execute decision accepts THE SAME CALL that staged it. The staging
  // slot clears on every path for that call; a stale entry from an outer
  // short-circuited chain (its verdict never reached us) is dropped when any
  // later call reaches the commit, never promoted.
  childCtx.on('tools/post-execute', async function (
    this: unknown, exec: ToolExecution, _result: ToolExecutionResult, next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> {
    if (exec.name !== STRUCTURED_OUTPUT_TOOL || pending === undefined) return next()
    if (pending.callId !== exec.callId) {
      // A stale stage from a different call: an outer listener short-circuited
      // that call's post-execute chain past this commit, so its verdict never
      // reached us and the value must never be promoted — drop it.
      pending = undefined
      return next()
    }
    const staged = pending
    try {
      const decision = await next()
      if (decision.kind === 'accept') captured = { value: staged.value }
      return decision
    } finally {
      if (pending === staged) pending = undefined
    }
  }, { prepend: true })

  return { captured: () => captured }
}
