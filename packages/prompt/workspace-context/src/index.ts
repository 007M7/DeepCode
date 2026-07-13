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
import type { PostToolDecision, ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { loadBaselineInstructionSet } from './files.ts'
import {
  baselineInstructionChanges,
  commitPendingInstructionContexts,
  dynamicInstructionContext,
  name,
  reconcileInstructionContext,
  rollbackPendingInstructionChanges,
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
  InstructionFile,
  LoadedInstructionFile,
} from './files.ts'
export { renderWorkspaceContext } from './render.ts'
export type { RenderedWorkspaceContext, TruncatedInstruction } from './render.ts'

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const pendingNestedChanges = new WeakMap<object, Map<string, PendingInstructionChange>>()
  const baselineInstructionStates = new WeakMap<object, Map<string, WorkspaceInstructionChange>>()
  const pendingByParent = new Map<ToolExecutionToken, { agent: Agent; changes: WorkspaceInstructionChange[] }>()

  ctx.on('agent/session-prefix', async (agent: Agent, _prefix, signal, next): Promise<Message[]> => {
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
      maxSourceBytes: resolved.maxSourceBytes,
      instructionFileCandidates: resolved.instructionFileCandidates,
      signal,
    }, fileSystem)
    baselineInstructionStates.set(agent.session, baselineInstructionChanges(instructions?.included ?? []))

    const update = await reconcileInstructionContext(
      agent,
      resolved,
      pendingNestedChanges,
      baselineInstructionStates,
      fileSystem,
      { includeBaselineScopes: false, signal },
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
      pendingNestedChanges,
      baselineInstructionStates,
      fileSystem,
    )
    if (context === undefined) return downstream
    return {
      kind: 'accept',
      ...downstream.content !== undefined ? { content: downstream.content } : {},
      additionalContexts: [context, ...downstream.additionalContexts ?? []],
    }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    if (exec.parent !== undefined) {
      if (exec.agent === undefined) return
      // Child contexts participate in duplicate suppression within one composite
      // run, but remain provisional until the parent reaches its final policy.
      const changes = commitPendingInstructionContexts(exec.agent, result.additionalContexts, pendingNestedChanges)
      if (changes.length === 0) return
      const staged = pendingByParent.get(exec.parent)
      if (staged === undefined) pendingByParent.set(exec.parent, { agent: exec.agent, changes })
      else staged.changes.push(...changes)
      return
    }

    // The parent result is authoritative: remove every provisional child change,
    // then commit only contexts that survived outer post-execute policy.
    const staged = pendingByParent.get(exec.token)
    if (staged !== undefined) {
      pendingByParent.delete(exec.token)
      rollbackPendingInstructionChanges(staged.agent, staged.changes, pendingNestedChanges)
    }
    if (exec.agent === undefined) return
    commitPendingInstructionContexts(exec.agent, result.additionalContexts, pendingNestedChanges)
  })
}
