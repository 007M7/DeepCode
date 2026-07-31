/**
 * Workspace instruction loader for AGENTS.md-compatible files.
 *
 * Baseline instructions enter durable context before the first request; successful fs
 * tool touches mark nested, changed, and removed instructions for reconciliation
 * at the next pre-step. Plugin lifecycle reads use
 * the optional `ctx.fs` provider, so providerless products mount it as a no-op.
 *
 * @module @deepseek-ai/dsh-workspace-context
 */

import type { Context } from 'cordis'
import { isDeepStrictEqual } from 'node:util'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { loadBaselineInstructionSet } from './files.ts'
import {
  applyInstructionVersionUpdates,
  baselineInstructionState,
  name,
  reconcileInstructionContext,
  workspaceContextMessage,
  type InstructionVersionCache,
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

function isWorkspaceContext(message: UserMessage): boolean {
  return message.source.kind === 'workspace-instructions'
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const filePath = exec.arguments.file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const pendingTouches = new Map<ToolExecutionToken, { agent: Agent; paths: Set<string> }>()
  const touchedPaths = new WeakMap<Agent, Set<string>>()

  const compose = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    pending: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<{
    desired?: UserMessage
    versions: Map<string, import('./state.ts').InstructionVersionState>
  }> => {
    signal.throwIfAborted()
    const candidateVersions: InstructionVersionCache = new WeakMap()
    const candidateVersionStates = new Map(instructionVersions.get(agent.session) ?? [])
    candidateVersions.set(agent.session, candidateVersionStates)
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
      return { versions: new Map() }
    }
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return { versions: new Map() }
    const content: UserMessage['content'][number][] = []
    const changes: WorkspaceInstructionChange[] = []
    let desiredBaseline = false
    const authorityMessages = [...claimed]
    const baselinePresent = hasVisibleBaseline(agent) || claimed.some(message =>
      message.source.kind === 'workspace-instructions' && message.source.baseline === true)
    if (!baselinePresent) {
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
      for (const [scope, state] of baseline.versions) candidateVersionStates.set(scope, state)
      if (instructions !== undefined && instructions.rendered.text.length > 0) {
        content.push(...workspaceContextMessage(instructions.rendered.text).content)
        changes.push(...baseline.changes.values())
        desiredBaseline = true
      }
    }
    const update = await reconcileInstructionContext(
      agent,
      resolved,
      candidateVersions,
      fileSystem,
      { authorityMessages, scopeMessages: pending, includeBaselineScopes: baselinePresent, touchedPaths, signal },
    )
    if (update !== undefined) {
      content.push(...update.context.content)
      /* v8 ignore next -- reconciliation constructs only workspace-instructions contexts. */
      if (update.context.source.kind === 'workspace-instructions') {
        changes.push(...update.context.source.changes)
      }
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, candidateVersions)
    }
    const versions = new Map(candidateVersions.get(agent.session) ?? [])
    return content.length === 0
      ? { versions }
      : {
        desired: createUserMessage({
          content,
          source: {
            kind: 'workspace-instructions',
            ...desiredBaseline ? { baseline: true } : {},
            changes,
          },
        }),
        versions,
      }
  }

  const syncInbox = (agent: Agent, claimed: readonly UserMessage[], desired: UserMessage | undefined): void => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const alreadySupplied = desired !== undefined && (
      claimed.some(message => sameContextPayload(message, desired))
      || agent.session.surface.nodes.some((seq) => {
        const event = agent.session.events[seq]
        return event?.type === 'user/message' && sameContextPayload(event.data, desired)
      })
    )
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove('next-step', message.id)
      return
    }
    const reusable = pending.find(message => sameContextPayload(message, desired))
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove('next-step', message.id)
      }
      return
    }
    const replaced = pending[0]
    if (replaced === undefined) agent.inbox.prepend('next-step', desired)
    else agent.inbox.update('next-step', replaced.id, desired)
    for (const message of pending.slice(1)) agent.inbox.remove('next-step', message.id)
  }

  const commitSync = (
    agent: Agent,
    claimed: readonly UserMessage[],
    desired: UserMessage | undefined,
    versions: Map<string, import('./state.ts').InstructionVersionState>,
  ): void => {
    syncInbox(agent, claimed, desired)
    if (versions.size === 0) instructionVersions.delete(agent.session)
    else instructionVersions.set(agent.session, versions)
  }

  const restoreTouchedPaths = (agent: Agent, paths: Set<string> | undefined): void => {
    if (paths === undefined || paths.size === 0) return
    const current = touchedPaths.get(agent)
    if (current === undefined) touchedPaths.set(agent, paths)
    else for (const path of paths) current.add(path)
  }

  ctx.on('agent/pre-step', async (
    agent: Agent,
    messages,
    { signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const paths = touchedPaths.get(agent)
    touchedPaths.delete(agent)
    try {
      const composed = await compose(agent, signal, messages, pending, [...paths ?? []])
      /* v8 ignore next 4 -- every awaited filesystem operation checks this signal before settling. */
      if (signal.aborted) {
        restoreTouchedPaths(agent, paths)
        return decision
      }
      commitSync(agent, messages, composed.desired, composed.versions)
      return decision
    } catch (error: unknown) {
      restoreTouchedPaths(agent, paths)
      throw error
    }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    const staged = pendingTouches.get(exec.token)
    pendingTouches.delete(exec.token)
    if (exec.parent !== undefined) {
      const paths = new Set(staged?.paths ?? [])
      const ownPath = result.isError ? undefined : filePathFromExecution(exec)
      if (ownPath !== undefined) paths.add(ownPath)
      if (!result.isError && exec.agent !== undefined && paths.size > 0) {
        const parent = pendingTouches.get(exec.parent)
        if (parent === undefined) pendingTouches.set(exec.parent, { agent: exec.agent, paths })
        else for (const path of paths) parent.paths.add(path)
      }
      return
    }
    if (result.isError || exec.agent === undefined) return
    const paths = new Set(staged?.paths ?? [])
    const ownPath = filePathFromExecution(exec)
    if (ownPath !== undefined) paths.add(ownPath)
    if (paths.size === 0) return
    const pending = touchedPaths.get(exec.agent)
    if (pending === undefined) touchedPaths.set(exec.agent, paths)
    else for (const path of paths) pending.add(path)
  })
}
