/**
 * Workspace instruction loader for AGENTS.md-compatible files.
 *
 * Baseline instructions are frozen into `agent/session-prefix`; successful fs
 * tool touches reconcile nested, changed, and removed instructions through
 * `tools/post-execute` for the next model request. Plugin lifecycle reads use
 * the optional `ctx.fs` provider, so providerless products mount it as a no-op.
 *
 * @module @deepseek-ai/dsh-workspace-context
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import {
  loadBaselineInstructionSet,
  type InstructionContentCache,
} from './files.ts'
import {
  baselineInstructionChanges,
  concatContext,
  dynamicInstructionContext,
  name,
  reconcileInstructionContext,
  workspaceContextMessage,
  type PendingInstructionChange,
} from './state.ts'
import type { WorkspaceInstructionChange } from './render.ts'

export { Config, name }
export {
  discoverBaselineInstructionFiles,
  loadBaselineInstructions,
} from './files.ts'
export type {
  InstructionContentCache,
  InstructionFile,
  LoadedInstructionFile,
} from './files.ts'
export { renderWorkspaceContext } from './render.ts'
export type { RenderedWorkspaceContext, TruncatedInstruction } from './render.ts'

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const cache: InstructionContentCache = new Map()
  const pendingNestedChanges = new WeakMap<object, Map<string, PendingInstructionChange>>()
  const baselineInstructionStates = new WeakMap<object, Map<string, WorkspaceInstructionChange>>()

  ctx.on('agent/session-prefix', async (agent: Agent, _prefix, _signal, next): Promise<Message[]> => {
    const rest = await next()
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) return rest
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return rest
    /* v8 ignore next -- normal agents carry an absolute session cwd. */
    const cwd = agent.session.header.cwd ?? process.cwd()
    const instructions = await loadBaselineInstructionSet({
      cwd,
      dshHome: resolved.dshHome,
      projectRootMarkers: resolved.projectRootMarkers,
      maxBytes: resolved.maxBytes,
      instructionFileCandidates: resolved.instructionFileCandidates,
      cache,
    }, fileSystem)
    baselineInstructionStates.set(agent.session, baselineInstructionChanges(instructions?.included ?? []))

    const update = await reconcileInstructionContext(
      agent,
      resolved,
      cache,
      pendingNestedChanges,
      baselineInstructionStates,
      fileSystem,
      { includeBaselineScopes: false },
    )
    if (update !== undefined) {
      agent.inject(update.content, {
        source: update.source,
        envelope: update.envelope,
        meta: update.meta,
      })
    }
    if (instructions === undefined || instructions.rendered.text.length === 0) return rest
    return [workspaceContextMessage(instructions.rendered.text), ...rest]
  })

  ctx.on('tools/post-execute', async (
    exec: ToolExecution,
    result: ToolExecutionResult,
    next,
  ): Promise<PostToolDecision> => {
    const downstream = await next()
    // A downstream listener/policy blocked this call: the registry turns it
    // into a final `isError` result, so treat it like a failed fs touch and
    // load nothing. Reconciling here would surface workspace instructions from
    // a call the pipeline rejected, violating the "successful fs tool touches"
    // contract, and would advance the nested/baseline tracking state off a
    // touch that never really happened.
    if (downstream.kind === 'block') return downstream
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return downstream
    const context = await dynamicInstructionContext(
      exec.agent,
      exec,
      result,
      resolved,
      cache,
      pendingNestedChanges,
      baselineInstructionStates,
      fileSystem,
    )
    if (context === undefined) return downstream
    return {
      kind: 'accept',
      ...downstream.content !== undefined ? { content: downstream.content } : {},
      additionalContext: concatContext(context, downstream.additionalContext),
    }
  })
}
