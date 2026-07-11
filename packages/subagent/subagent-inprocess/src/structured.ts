/**
 * Child-scoped structured-output capture. Values commit only after the final
 * tool outcome; guards and terminal turn policy prevent work after capture.
 * @module @deepseek-ai/dsh-subagent-inprocess/structured
 */

import type { Context } from 'cordis'
import type { ContinuationStop } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolArgsError, validateStructuredValue, type StructuredOutputSchema } from '@deepseek-ai/dsh-tools'

/** The model-facing tool name a structured child must call to finish. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/** Prompt instruction paired with the child-scoped capture tool. */
export const STRUCTURED_OUTPUT_INSTRUCTION
  = 'When you have your final answer, you MUST report it by calling the '
    + `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only the tool call counts as your result.'

/** One structured run's live handle: read the captured value once the child settles. */
export interface StructuredAttachment {
  /** @returns the committed value, or `undefined` until one is accepted. */
  captured(): { value: unknown } | undefined
}

/**
 * Install structured-output capture in a child's setup scope.
 * @param childCtx - child agent scope context.
 * @param schema - validated schema enforced by the capture tool.
 * @returns handle for reading the committed value after settlement.
 */
export function attachStructuredRuntime(childCtx: Context, schema: StructuredOutputSchema): StructuredAttachment {
  // Stages are keyed by pipeline identity, not reusable model call ids.
  const staged = new WeakMap<ToolExecution, { value: unknown }>()
  /** Successful nested capture waiting for its enclosing transport to commit. */
  let pending: { parent: ToolExecution['token']; value: unknown } | undefined
  let captured: { value: unknown } | undefined

  const schemaEntry: ToolSchema = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    // The validated subset is a wire-level JSON Schema object.
    parameters: schema as unknown as Record<string, unknown>,
  }

  childCtx.tools.register({
    ...schemaEntry,
    execute(args: unknown, exec: ToolExecution): Promise<ContentBlock[]> {
      const violations = validateStructuredValue(schema, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      // Commit waits for this execution's final result.
      staged.set(exec, { value: structuredClone(args) })
      return Promise.resolve([{ type: 'text', text: 'Structured output recorded.' }])
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: 190,
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  })

  // Protection preserves the mode-appropriate canonical presence or absence.
  childCtx.systemPrompt.protect({
    sections: [`tool:${STRUCTURED_OUTPUT_TOOL}`],
    tools: [STRUCTURED_OUTPUT_TOOL],
  })

  childCtx.on('agent/turn-stop', function (this: unknown): ContinuationStop | undefined {
    return captured === undefined ? undefined : { action: 'stop' }
  })

  // Calls earlier in the same response remain valid; later calls are terminally denied.
  childCtx.tools.guard(exec => captured === undefined && pending === undefined
    ? undefined
    : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`)

  childCtx.on('tools/result', function (this: unknown, exec, result): void {
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
