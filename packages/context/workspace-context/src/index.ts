/**
 * Workspace instruction loader for AGENTS.md-compatible files.
 *
 * Baseline instructions enter durable context before the first request; successful fs
 * tool touches reconcile nested, changed, and removed instructions through
 * `tools/post-execute` for the next model request. Plugin lifecycle reads use
 * the optional `ctx.fs` provider, so providerless products mount it as a no-op.
 *
 * @module @deepseek-ai/dsh-workspace-context
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { loadBaselineInstructionSet } from './files.ts'
import {
  applyInstructionVersionUpdates,
  baselineInstructionState,
  commitPendingInstructionContexts,
  dynamicInstructionContext,
  name,
  observeInstructionSessionEvent,
  reconcileInstructionContext,
  retainedInstructionVersionUpdates,
  rollbackPendingInstructionChanges,
  workspaceContextMessage,
  type InstructionVersionCache,
  type InstructionVersionUpdate,
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

function hasVisibleBaseline(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.events[seq]
    return event?.type === 'user/message'
      && event.data.source.kind === 'workspace-instructions'
      && event.data.source.baseline === true
  })
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const pendingNestedChanges = new WeakMap<object, Map<string, PendingInstructionChange>>()
  const baselineSessions = new WeakSet<object>()
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const pendingVersionUpdates = new Map<ToolExecutionToken, InstructionVersionUpdate[]>()
  const baselineLoaded = new WeakSet<object>()
  // Sessions whose lifecycle start this mount witnessed. A startup or resume
  // emits agent/session-start before the first step; a hot remount attaches to
  // an already-live session and never sees it. Resumes always re-compose the
  // baseline from current files. Hot remounts retain a baseline only while its
  // typed event remains model-visible.
  const lifecycleWitnessed = new WeakSet<object>()
  const pendingByParent = new Map<ToolExecutionToken, {
    agent: Agent
    changes: WorkspaceInstructionChange[]
    versionUpdates: InstructionVersionUpdate[]
  }>()

  ctx.on('agent/session-start', (agent: Agent) => {
    lifecycleWitnessed.add(agent.session)
  })

  ctx.on('session/event', (session, event) => {
    observeInstructionSessionEvent(session, event, pendingNestedChanges, instructionVersions)
  })

  ctx.on('agent/step', async (agent: Agent, _turn, _step, signal): Promise<void> => {
    if (baselineLoaded.has(agent.session)) return
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
      baselineLoaded.add(agent.session)
      return
    }
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) {
      baselineLoaded.add(agent.session)
      return
    }
    /* v8 ignore next -- normal agents carry an absolute session cwd. */
    const cwd = agent.session.header.cwd ?? process.cwd()
    const instructions = await loadBaselineInstructionSet({
      cwd,
      dshHome: resolved.dshHome,
      projectRootMarkers: resolved.projectRootMarkers,
      maxBytes: resolved.maxBytes,
      maxSourceBytes: resolved.maxSourceBytes,
      instructionFileCandidates: resolved.instructionFileCandidates,
      localInstructionFileCandidates: resolved.localInstructionFileCandidates,
      signal,
    }, fileSystem)
    const baseline = baselineInstructionState(instructions?.included ?? [])
    baselineSessions.add(agent.session)
    instructionVersions.set(agent.session, baseline.versions)

    const update = await reconcileInstructionContext(
      agent,
      resolved,
      pendingNestedChanges,
      instructionVersions,
      fileSystem,
      { includeBaselineScopes: false, signal },
    )
    if (update !== undefined) {
      agent.inject(update.context)
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, instructionVersions)
    }
    const keepVisibleBaseline = !lifecycleWitnessed.has(agent.session) && hasVisibleBaseline(agent)
    if (!keepVisibleBaseline && instructions !== undefined && instructions.rendered.text.length > 0) {
      const baselineMessage = workspaceContextMessage(instructions.rendered.text)
      agent.inject(createUserMessage({
        content: baselineMessage.content,
        source: {
          kind: 'workspace-instructions',
          baseline: true,
          changes: [...baseline.changes.values()],
        },
      }))
    }
    baselineLoaded.add(agent.session)
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
    const update = await dynamicInstructionContext(
      exec.agent,
      exec,
      result,
      resolved,
      pendingNestedChanges,
      baselineSessions,
      instructionVersions,
      fileSystem,
    )
    if (update === undefined) return downstream
    pendingVersionUpdates.set(exec.token, update.versionUpdates)
    return {
      ...downstream,
      additionalContexts: [update.context, ...downstream.additionalContexts ?? []],
    }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    const ownVersionUpdates = pendingVersionUpdates.get(exec.token) ?? []
    pendingVersionUpdates.delete(exec.token)
    if (exec.parent !== undefined) {
      if (exec.agent === undefined) return
      // Child contexts participate in duplicate suppression within one composite
      // run, but remain provisional until the parent reaches its final policy.
      const changes = commitPendingInstructionContexts(exec.agent, result.additionalContexts, pendingNestedChanges)
      if (changes.length === 0) return
      const versionUpdates = retainedInstructionVersionUpdates(ownVersionUpdates, changes)
      const staged = pendingByParent.get(exec.parent)
      if (staged === undefined) pendingByParent.set(exec.parent, { agent: exec.agent, changes, versionUpdates })
      else {
        staged.changes.push(...changes)
        staged.versionUpdates.push(...versionUpdates)
      }
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
    const committed = commitPendingInstructionContexts(exec.agent, result.additionalContexts, pendingNestedChanges)
    const stagedVersionUpdates = staged?.versionUpdates ?? []
    const versionUpdates = retainedInstructionVersionUpdates(
      [...stagedVersionUpdates, ...ownVersionUpdates],
      committed,
    )
    applyInstructionVersionUpdates(exec.agent.session, versionUpdates, instructionVersions)
  })
}
