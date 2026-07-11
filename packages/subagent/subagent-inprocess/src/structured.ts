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
 * Four listeners enforce the contract:
 *
 * - `system-prompt/assemble` (prepend, scoped): assembly re-assert — the
 *   listener post-processes its downstream chain so a listener inside that
 *   chain cannot leave the child's capture tool or instruction stripped or
 *   replaced. Tools are replaced in place and the section is re-inserted at
 *   its ascending-order position, so the untampered path keeps the registry's
 *   ordering (up to intra-band section order, which carries no contract). A
 *   listener prepended later can still wrap and transform this result; this is
 *   an ordinary waterfall listener, not a service-level finalizer. The loop
 *   logs the rendered assembly as the request header, so the demand is
 *   reconstructable log state, never a wire-only mutation.
 * - `agent/turn-continuation` (prepend, scoped): stop the child's turn once
 *   its output is captured — the loop's default "had tool calls ⇒ continue"
 *   would buy a wasted extra model step per structured child.
 * - `tools/pre-execute` (prepend, scoped): terminal means terminal WITHIN the
 *   step — deny every call arriving after the capture, so a response that
 *   lists `structured_output` before further tool calls cannot run side
 *   effects after the final answer was accepted.
 * - `tools/post-execute` (prepend, scoped): the capture COMMIT. The tool body
 *   only STAGES the validated value, KEYED BY THE EXECUTION OBJECT in a
 *   WeakMap; it becomes the run's captured result when this listener's
 *   downstream post-execute decision accepts THAT SAME pipeline trip. A
 *   later-prepended wrapper remains outside that decision. Execution-keyed
 *   staging makes the stale-stage class structurally impossible: a value
 *   orphaned by an outer short-circuiting listener (a post-execute block, or
 *   a pre-execute deny whose call never dispatched) can never match another
 *   execution's lookup — whatever call id that execution carries — and is
 *   reclaimed with the execution object itself.
 *
 * @module @deepseek-ai/dsh-subagent-inprocess/structured
 */

import type { Context } from 'cordis'
import type { Agent, ContinuationDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
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
  /**
   * Validated values staged by the capture tool body, awaiting THEIR OWN
   * call's post-execute verdict — keyed by the {@link ToolExecution} OBJECT,
   * the one token that provably ties a stage to one trip through the
   * pipeline. A call id cannot key this: ids are adapter-minted and may
   * repeat across steps. Keying by execution makes the stale-stage class
   * structurally impossible — an entry orphaned by an outer short-circuiting
   * listener can never match a different execution's lookup, needs no drop
   * bookkeeping (the WeakMap reclaims it with the execution object), and two
   * in-flight captures can never cross-clobber each other's STAGE should
   * tool execution ever go parallel (the loop's documented TODO). Staging is
   * the only layer this future-proofs: a parallel-execution cut would still
   * owe its own single-accept rule for `captured` itself.
   */
  const staged = new WeakMap<ToolExecution, { value: unknown }>()
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
      // Two-phase commit, KEYED BY THIS EXECUTION: the body only stages; the
      // post-execute listener promotes exactly this pipeline trip's entry
      // when its downstream decision accepts it.
      staged.set(exec, { value: args })
      return Promise.resolve([{ type: 'text', text: 'Structured output recorded.' }])
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: 190,
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  })

  // PREPENDED assembly re-assert: scoped dispatch means this fires only for the
  // child's assemblies; `await next()` returns whatever this listener's
  // downstream chain produced, and the capture tool + instruction are
  // re-asserted onto it if anything stripped them. A listener prepended later
  // can still wrap and transform the returned assembly; this is not a
  // service-level finalizer.
  childCtx.on('system-prompt/assemble', async function (
    this: unknown, _assembly: PromptAssembly, _context: AssembleContext, next: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly> {
    const final = await next()
    // REPLACE, not merely ensure-present: a downstream listener may have
    // mutated or injected a same-named entry with the WRONG schema/text, and
    // the model-visible demand must be exactly this run's own — the same
    // schema validateStructuredValue enforces. Placement-preserving on both
    // arrays: the untampered path keeps the registry's ordering (tool order
    // is the `toolOrder`/lexicographic contract, section order the ascending
    // contract `renderPrompt` trusts), so this never reorders what it only
    // re-asserts — up to intra-band section order, which carries no contract
    // (a 190-order section registered AFTER this runtime sorts before the
    // instruction in the registry but after it here).
    const freshTool: ToolSchema = { ...schemaEntry, parameters: structuredClone(schemaEntry.parameters) }
    // Tools: replace the first same-named entry IN PLACE (its position is the
    // chain's product; a tool's list position carries no semantic band to
    // restore), drop any duplicates, append only when stripped entirely.
    const tools: ToolSchema[] = []
    let toolReplaced = false
    for (const tool of final.tools) {
      if (tool.name !== STRUCTURED_OUTPUT_TOOL) {
        tools.push(tool)
      } else if (!toolReplaced) {
        tools.push(freshTool)
        toolReplaced = true
      }
    }
    if (!toolReplaced) tools.push(freshTool)
    final.tools = tools
    // Sections: remove every same-named entry and re-insert at the
    // ascending-correct position (the first entry above order 190) — sections
    // DO carry an order contract, and the renderer reads array order, so a
    // stripped-or-moved instruction is restored to its band, not appended
    // after unrelated higher-order sections. On the untampered path this
    // lands at the end of the 190 band — where the registry's stable sort
    // put it too, unless another 190-order section registered later.
    const sectionName = `tool:${STRUCTURED_OUTPUT_TOOL}`
    const sections = final.sections.filter(section => section.name !== sectionName)
    const insertAt = sections.findIndex(section => section.order > 190)
    sections.splice(insertAt === -1 ? sections.length : insertAt, 0, { name: sectionName, order: 190, text: STRUCTURED_OUTPUT_INSTRUCTION })
    final.sections = sections
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

  // The capture COMMIT: promote a staged value only when the final
  // post-execute decision accepts THE SAME EXECUTION that staged it — the
  // lookup key IS the execution, so a stale entry from a different pipeline
  // trip (its own chain short-circuited past this commit by an outer
  // post-execute block, or an outer pre-execute deny whose call never
  // dispatched) is unreachable here by construction, whatever the current
  // call's id.
  childCtx.on('tools/post-execute', async function (
    this: unknown, exec: ToolExecution, _result: ToolExecutionResult, next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> {
    if (exec.name !== STRUCTURED_OUTPUT_TOOL) return next()
    const entry = staged.get(exec)
    if (entry === undefined) return next()
    // Single-shot per execution: this trip's verdict is decided by the chain
    // below, never revisited (the WeakMap would reclaim the entry either way;
    // deleting states the intent).
    staged.delete(exec)
    const decision = await next()
    if (decision.kind === 'accept') captured = { value: entry.value }
    return decision
  }, { prepend: true })

  return { captured: () => captured }
}
