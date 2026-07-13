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
 * a disposed child leaves no residue — no placeholder schema,
 * strip-for-everyone-else pass, or refcounted global runtime.
 *
 * The child scope's registrations enforce the contract:
 *
 * - The scoped capture tool and instruction are ordinary assembly inputs. The
 *   loop logs the assembled request header, so the demand is reconstructable
 *   log state rather than a wire-only mutation. As with every other assembly
 *   contribution, an expert `system-prompt/assemble` listener that deliberately
 *   removes or replaces either input owns the resulting composition.
 * - `agent/turn-stop` (serial, scoped): stop the child's turn once its output
 *   is captured. This terminal checkpoint runs after the ordinary continuation
 *   waterfall and steering folding, so listener order cannot resurrect a
 *   completed structured run or carry terminal steering into another turn.
 * - `tools.guard()` is the monotonic terminal gate after the extensible
 *   pre-execute waterfall: once capture commits, no later listener can turn
 *   the denial back into a dispatched side effect.
 * - `tools/result` is the capture COMMIT point. The tool body only STAGES the
 *   validated value in a WeakMap keyed by the execution object; the awaited,
 *   non-transforming notification promotes it only when the authoritative
 *   result after the whole pre/execute/post pipeline succeeds. For a Code Mode
 *   sub-dispatch, promotion waits again for the enclosing `run_code` result, so
 *   a runtime failure or outer post-policy block cannot report structured
 *   success. Execution identity makes call-id reuse and orphaned stages
 *   irrelevant.
 *
 * @module @deepseek-ai/dsh-subagent-inprocess/structured
 */

import type { Context } from 'cordis'
import type { ContinuationStop } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
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
   * and the authoritative final tool result accepted that call.
   * @returns the committed value, or undefined while none was accepted.
   */
  captured(): { value: unknown } | undefined
}

/**
 * Attach the structured-output runtime to a child for `schema`: register the
 * scoped capture tool (real schema), the scoped instruction section, and the
 * scoped enforcement registrations (see the module doc). Call from the
 * agent-creation `setup` window with the child's scope context — every
 * registration rides the child's fiber and unwinds with the child.
 * @param childCtx - the child agent's scope context (`setup`'s argument).
 * @param schema - the trusted, already-asserted schema subset to enforce (see
 *   `assertSupportedOutputSchema` in dsh-tools).
 * @returns the attachment handle (read `captured()` after the child settles).
 */
export function attachStructuredRuntime(childCtx: Context, schema: StructuredOutputSchema): StructuredAttachment {
  /**
   * Validated values staged by the capture tool body, awaiting THEIR OWN
   * authoritative `tools/result` notification. The execution object's identity
   * uniquely identifies a trip through the pipeline: adapter call ids may
   * repeat across steps, but another execution can never reach this WeakMap
   * entry. This is distinct from the opaque `ToolExecutionToken` used to
   * correlate nested transports. The final notification always deletes its own
   * stage, whether the result succeeded or failed.
   */
  const staged = new WeakMap<ToolExecution, { value: unknown }>()
  /** Successful nested capture waiting for its enclosing transport to commit. */
  let pending: { parent: ToolExecution['token']; value: unknown } | undefined
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
      // Two-phase commit, keyed by THIS execution: later transformable
      // waterfalls may still turn the success into an error. ToolRegistry has
      // already frozen model-bound arguments at the actual input boundary.
      staged.set(exec, { value: args })
      return Promise.resolve([{ type: 'text', text: 'Structured output recorded.' }])
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: 190,
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  })

  // Stop the child's turn once its output is captured. This monotonic serial
  // checkpoint runs after the ordinary continuation waterfall, its reason,
  // and late-steering folding, so no ordering trick can resume a finished run.
  childCtx.on('agent/turn-stop', function (this: unknown): ContinuationStop | undefined {
    return captured === undefined ? undefined : { action: 'stop' }
  })

  // Terminal WITHIN the step. Guards run after the whole pre-execute
  // waterfall and compose monotonically (deny or abstain, never allow), so a
  // later prepended listener cannot resurrect dispatch. Calls that precede
  // capture in the same response remain untouched.
  childCtx.tools.guard(exec => captured === undefined && pending === undefined
    ? undefined
    : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`)

  // The capture COMMIT observes the immutable, authoritative result after the
  // complete pipeline and outer error normalization. This notification cannot
  // transform the outcome, so there is no wrapper outside the commit verdict.
  childCtx.on('tools/result', function (this: unknown, exec, result) {
    if (exec.name === STRUCTURED_OUTPUT_TOOL) {
      const entry = staged.get(exec)
      if (entry === undefined) return
      staged.delete(exec)
      if (result.isError) return
      if (exec.parent === undefined) {
        /* v8 ignore else -- sequential agent-loop dispatch lets the guard block every later supported call */
        if (captured === undefined) captured = { value: entry.value }
      } else {
        /* v8 ignore else -- Code Mode serializes sub-dispatches, so the guard blocks every later supported call */
        if (captured === undefined && pending === undefined) {
          pending = { parent: exec.parent, value: entry.value }
        }
      }
      return
    }
    if (pending?.parent !== exec.token) return
    const entry = pending
    pending = undefined
    if (result.isError) return
    /* v8 ignore else -- Code Mode serializes outer executions, so the guard blocks every later supported call */
    if (captured === undefined) captured = { value: entry.value }
  })

  return { captured: () => captured }
}
