/**
 * Session-visible workspace instruction state and dynamic reconciliation.
 *
 * @module @deepseek-ai/dsh-workspace-context/state
 */

import type { Agent, HookContext } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { JsonValue, Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileSystem, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import { instructionContentSha1, trimmedInstructionDigest } from './digest.ts'
import {
  ancestorChain,
  descendantDirsBetween,
  findProjectRoot,
  probeScopeInstruction,
  readScopeInstruction,
  relativeDisplay,
  type LoadedInstructionFile,
} from './files.ts'
import {
  candidateScopeKey,
  decodeScopeKey,
  instructionScopeKey,
  renderInstructionChanges,
  USER_GLOBAL_DIRECTORY,
  USER_GLOBAL_FILE,
  type ChangeRenderItem,
  type WorkspaceInstructionChange,
} from './render.ts'

export const name = 'workspace-context'

const PLUGIN_SOURCE = { kind: 'plugin', plugin: name } as const
const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

/** Dynamic state waiting for the loop to append its returned context event. */
export interface PendingInstructionChange {
  change: WorkspaceInstructionChange
  afterSeq: number
  step?: { turn: number; step: number }
}

/** Per-scope metadata cache; instruction prose is deliberately not retained. */
export interface InstructionVersionState {
  path: string
  version: FsVersion
  digest: string
  /**
   * Trimmed-content identity ({@link trimmedInstructionDigest}) used to suppress
   * per-directory duplicates on the metadata fast path without re-reading a sibling.
   */
  trimmedDigest: string
}

/** Session-isolated fast-path state keyed by logical instruction scope. */
export type InstructionVersionCache = WeakMap<Session, Map<string, InstructionVersionState>>

/** A cache transition coupled to the model-visible change that authorizes it. */
export interface InstructionVersionUpdate {
  change: WorkspaceInstructionChange
  state?: InstructionVersionState
}

/** Rendered reconciliation plus cache transitions awaiting final policy. */
export interface ReconciledInstructionContext {
  context: WorkspaceHookContext
  versionUpdates: InstructionVersionUpdate[]
}

/** Plugin-owned context with required replay metadata. */
export interface WorkspaceHookContext extends HookContext {
  meta: JsonValue
}

function workspaceContextHook(text: string, changes: WorkspaceInstructionChange[]): WorkspaceHookContext {
  const serializedChanges: JsonValue[] = changes.map(change => ({
    action: change.action,
    scope: change.scope,
    path: change.path,
    ...change.digest !== undefined ? { digest: change.digest } : {},
  }))
  const meta: JsonValue = { kind: 'workspace-instructions', version: 1, changes: serializedChanges }
  return { content: [{ type: 'text', text }], source: PLUGIN_SOURCE, meta }
}

/**
 * Build the request-prefix message for a rendered baseline.
 * @param text - complete plugin-owned system-reminder text.
 * @returns a user-role prefix message.
 */
export function workspaceContextMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const filePath = exec.arguments.file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

function isWorkspaceContextSource(source: unknown): source is typeof PLUGIN_SOURCE {
  return typeof source === 'object' && source !== null
    && 'kind' in source && source.kind === 'plugin'
    && 'plugin' in source && source.plugin === name
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workspaceInstructionChanges(meta: JsonValue | undefined): WorkspaceInstructionChange[] {
  if (!isRecord(meta) || meta.kind !== 'workspace-instructions' || meta.version !== 1 || !Array.isArray(meta.changes)) return []
  const changes: WorkspaceInstructionChange[] = []
  for (const value of meta.changes) {
    if (!isRecord(value)) continue
    if (value.action !== 'set' && value.action !== 'replace' && value.action !== 'remove') continue
    if (typeof value.scope !== 'string' || typeof value.path !== 'string') continue
    if (value.digest !== undefined && typeof value.digest !== 'string') continue
    changes.push({
      action: value.action,
      scope: value.scope,
      path: value.path,
      ...value.digest !== undefined ? { digest: value.digest } : {},
    })
  }
  return changes
}

function sameInstructionChange(a: WorkspaceInstructionChange, b: WorkspaceInstructionChange): boolean {
  return a.action === b.action
    && a.scope === b.scope
    && a.path === b.path
    && a.digest === b.digest
}

function visibleInstructionChanges(
  agent: Agent,
  pending: Map<string, PendingInstructionChange>,
): Map<string, WorkspaceInstructionChange> {
  const visibleSeqs = new Set(agent.session.surface.nodes)
  const visible = new Map<string, WorkspaceInstructionChange>()
  for (const [seq, event] of agent.session.events.entries()) {
    if (event.type !== 'user/message' || !isWorkspaceContextSource(event.data.source)) continue
    const changes = workspaceInstructionChanges(event.data.meta)
    for (const change of changes) {
      const waiting = pending.get(change.scope)
      if (waiting !== undefined && seq >= waiting.afterSeq && sameInstructionChange(waiting.change, change)) {
        pending.delete(change.scope)
      }
      if (visibleSeqs.has(seq)) visible.set(change.scope, change)
    }
  }
  for (const { change } of pending.values()) visible.set(change.scope, change)
  return visible
}

/**
 * Convert retained baseline files into comparison and metadata-cache state.
 * @param files - baseline files that survived rendering.
 * @returns latest baseline changes and provider versions keyed by logical scope.
 */
export function baselineInstructionState(files: LoadedInstructionFile[]): {
  changes: Map<string, WorkspaceInstructionChange>
  versions: Map<string, InstructionVersionState>
} {
  const changes = new Map<string, WorkspaceInstructionChange>()
  const versions = new Map<string, InstructionVersionState>()
  for (const file of files) {
    const digest = instructionContentSha1(file.content)
    const change: WorkspaceInstructionChange = {
      action: 'set',
      scope: instructionScopeKey(file.displayPath),
      path: file.displayPath,
      digest,
    }
    changes.set(change.scope, change)
    if (file.version !== undefined) {
      versions.set(change.scope, {
        path: file.displayPath,
        version: file.version,
        digest,
        trimmedDigest: trimmedInstructionDigest(file.content),
      })
    }
  }
  return { changes, versions }
}

function versionStatesFor(session: Session, cache: InstructionVersionCache): Map<string, InstructionVersionState> {
  let states = cache.get(session)
  if (states === undefined) {
    states = new Map()
    cache.set(session, states)
  }
  return states
}

/**
 * Keep only cache updates whose model-visible changes survived final policy.
 * @param updates - proposed updates from one or more reconciliations.
 * @param committedChanges - transitions retained on the authoritative result.
 * @returns updates authorized by an exact retained transition.
 */
export function retainedInstructionVersionUpdates(
  updates: readonly InstructionVersionUpdate[],
  committedChanges: readonly WorkspaceInstructionChange[],
): InstructionVersionUpdate[] {
  return updates.filter(update => committedChanges.some(change => sameInstructionChange(update.change, change)))
}

/**
 * Apply authorized metadata-cache transitions without retaining instruction prose.
 * @param session - owning session.
 * @param updates - ordered set/delete transitions.
 * @param cache - session-isolated metadata cache.
 */
export function applyInstructionVersionUpdates(
  session: Session,
  updates: readonly InstructionVersionUpdate[],
  cache: InstructionVersionCache,
): void {
  if (updates.length === 0) return
  const states = versionStatesFor(session, cache)
  for (const update of updates) {
    if (update.state === undefined) states.delete(update.change.scope)
    else states.set(update.change.scope, update.state)
  }
  if (states.size === 0) cache.delete(session)
}

function pendingChangesFor(
  session: object,
  pendingBySession: WeakMap<object, Map<string, PendingInstructionChange>>,
): Map<string, PendingInstructionChange> {
  let pending = pendingBySession.get(session)
  if (pending === undefined) {
    pending = new Map()
    pendingBySession.set(session, pending)
  }
  return pending
}

function openStep(session: Session): { turn: number; step: number } | undefined {
  const boundary = session.events.findLast(event => event.type === 'step/start' || event.type === 'step/end')
  return boundary?.type === 'step/start' ? boundary.data : undefined
}

function invalidateInstructionVersions(
  session: Session,
  scopes: readonly string[],
  cache: InstructionVersionCache,
): void {
  const states = cache.get(session)
  if (states === undefined) return
  for (const scope of scopes) states.delete(scope)
  if (states.size === 0) cache.delete(session)
}

/**
 * Settle provisional tool-result state against durable session events.
 * A matching context event confirms the transition. If its owning step closes
 * first, both duplicate suppression and the metadata fast path are re-armed for
 * the next successful touch.
 * @param session - session whose append-only log emitted `event`.
 * @param event - newly committed session event.
 * @param pendingBySession - provisional transitions awaiting log confirmation.
 * @param versionCache - metadata fast path coupled to those transitions.
 */
export function observeInstructionSessionEvent(
  session: Session,
  event: SessionEvent,
  pendingBySession: WeakMap<object, Map<string, PendingInstructionChange>>,
  versionCache: InstructionVersionCache,
): void {
  const pending = pendingBySession.get(session)
  if (pending === undefined) return

  switch (event.type) {
    case 'user/message': {
      if (!isWorkspaceContextSource(event.data.source)) return
      for (const change of workspaceInstructionChanges(event.data.meta)) {
        const waiting = pending.get(change.scope)
        if (waiting !== undefined && event.seq >= waiting.afterSeq && sameInstructionChange(waiting.change, change)) {
          pending.delete(change.scope)
        }
      }
      if (pending.size === 0) pendingBySession.delete(session)
      return
    }
    case 'step/end': {
      const discardedScopes: string[] = []
      for (const [scope, waiting] of pending) {
        const step = waiting.step
        if (step === undefined || step.turn !== event.data.turn || step.step !== event.data.step) continue
        pending.delete(scope)
        discardedScopes.push(scope)
      }
      if (pending.size === 0) pendingBySession.delete(session)
      invalidateInstructionVersions(session, discardedScopes, versionCache)
      return
    }
    default:
      // SessionEventMap is merge-extensible; unrelated events do not settle workspace state.
      return
  }
}

/**
 * Commit only workspace contexts that survived the complete tool pipeline.
 * The observe-only `tools/result` notification calls this before the loop can
 * append the returned contexts, closing that short pending window without
 * trusting an intermediate post-execute decision.
 * @param agent - session that will receive the final result contexts.
 * @param contexts - immutable contexts on the authoritative top-level result.
 * @param pendingBySession - per-session pending transition maps.
 * @returns transitions committed into the short pending window.
 */
export function commitPendingInstructionContexts(
  agent: Agent,
  contexts: readonly HookContext[] | undefined,
  pendingBySession: WeakMap<object, Map<string, PendingInstructionChange>>,
): WorkspaceInstructionChange[] {
  const committed: WorkspaceInstructionChange[] = []
  const step = openStep(agent.session)
  for (const context of contexts ?? []) {
    if (!isWorkspaceContextSource(context.source)) continue
    const changes = workspaceInstructionChanges(context.meta)
    if (changes.length === 0) continue
    const pending = pendingChangesFor(agent.session, pendingBySession)
    for (const change of changes) {
      pending.set(change.scope, {
        change,
        afterSeq: agent.session.seq,
        ...step === undefined ? {} : { step },
      })
      committed.push(change)
    }
  }
  return committed
}

/**
 * Roll back parent-token state when an enclosing tool result discards deferred
 * contexts. A newer transition for the same scope is left intact.
 * @param agent - session whose pending state was staged.
 * @param changes - exact staged transitions to remove when still current.
 * @param pendingBySession - per-session pending transition maps.
 */
export function rollbackPendingInstructionChanges(
  agent: Agent,
  changes: readonly WorkspaceInstructionChange[],
  pendingBySession: WeakMap<object, Map<string, PendingInstructionChange>>,
): void {
  const pending = pendingBySession.get(agent.session)
  if (pending === undefined) return
  for (const change of changes) {
    const current = pending.get(change.scope)
    if (current !== undefined && sameInstructionChange(current.change, change)) pending.delete(change.scope)
  }
  if (pending.size === 0) pendingBySession.delete(agent.session)
}

function relativeScope(projectRoot: string, dir: string): string {
  const scope = relativeDisplay(projectRoot, dir)
  return scope.length === 0 ? '.' : scope
}

/**
 * Compare visible/pending state with provider-visible files and render transitions.
 * @param agent - session owner whose visible surface supplies durable state.
 * @param resolved - normalized plugin configuration.
 * @param pendingBySession - short pending window before returned context is logged.
 * @param baselineBySession - frozen baseline comparison state per session.
 * @param versionCache - per-session scope metadata used to skip unchanged reads.
 * @param fileSystem - provider used for current file probes.
 * @param options - touched path and whether baseline scopes should be checked.
 * @returns rendered context plus deferred cache updates, or undefined when unchanged/unavailable.
 */
export async function reconcileInstructionContext(
  agent: Agent,
  resolved: ResolvedConfig,
  pendingBySession: WeakMap<object, Map<string, PendingInstructionChange>>,
  baselineBySession: WeakMap<object, Map<string, WorkspaceInstructionChange>>,
  versionCache: InstructionVersionCache,
  fileSystem: FileSystem,
  options: { touchedPath?: string; includeBaselineScopes: boolean; signal?: AbortSignal },
): Promise<ReconciledInstructionContext | undefined> {
  const session = agent.session
  const pending = pendingChangesFor(session, pendingBySession)
  const visible = visibleInstructionChanges(agent, pending)
  const effective = new Map(baselineBySession.get(session) ?? [])
  for (const [scope, change] of visible) effective.set(scope, change)
  /* v8 ignore next -- normal agents carry an absolute session cwd. */
  const cwd = session.header.cwd ?? process.cwd()
  // TODO(frozen-project-root): retain the baseline root for the loop instance;
  // recomputing it after marker edits reinterprets the existing relative scope keys.
  const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, options.signal)
  const scopes = new Set<string>()
  const addDirScopes = (directory: string): void => {
    for (const candidate of resolved.instructionFileCandidates) scopes.add(candidateScopeKey(directory, candidate))
    for (const candidate of resolved.localInstructionFileCandidates) scopes.add(candidateScopeKey(directory, candidate))
  }
  const addProjectScopes = (dir: string): void => {
    addDirScopes(relativeScope(projectRoot, dir))
  }
  if (options.includeBaselineScopes) {
    scopes.add(candidateScopeKey(USER_GLOBAL_DIRECTORY, USER_GLOBAL_FILE))
    for (const dir of ancestorChain(projectRoot, cwd)) addProjectScopes(dir)
  }
  for (const scope of effective.keys()) {
    const { directory } = decodeScopeKey(scope)
    if (directory === USER_GLOBAL_DIRECTORY) scopes.add(candidateScopeKey(USER_GLOBAL_DIRECTORY, USER_GLOBAL_FILE))
    else addDirScopes(directory)
  }
  if (options.touchedPath !== undefined) {
    for (const dir of descendantDirsBetween(cwd, options.touchedPath)) addProjectScopes(dir)
  }

  const versions = versionStatesFor(session, versionCache)
  const seenAbsolutePaths = new Set<string>()
  // Per-directory trimmed-content identities kept so far this pass, iterated in
  // candidate order (base before local); a later sibling matching an earlier one
  // is a duplicate and is dropped or removed rather than rendered twice.
  const keptTrimmedByDir = new Map<string, Set<string>>()
  const registerKeptTrimmed = (directory: string, digest: string): boolean => {
    let digests = keptTrimmedByDir.get(directory)
    if (digests === undefined) {
      digests = new Set()
      keptTrimmedByDir.set(directory, digests)
    }
    if (digests.has(digest)) return true
    digests.add(digest)
    return false
  }
  const items: ChangeRenderItem[] = []
  const versionUpdates: InstructionVersionUpdate[] = []
  const pushRemoval = (scope: string, path: string): void => {
    const change: WorkspaceInstructionChange = { action: 'remove', scope, path }
    items.push({ change, file: { absolutePath: `removed:${scope}`, displayPath: path, content: '' } })
    versionUpdates.push({ change })
  }
  for (const scope of scopes) {
    const { directory } = decodeScopeKey(scope)
    const previous = effective.get(scope)
    const probe = await probeScopeInstruction(scope, projectRoot, resolved, fileSystem, options.signal)
    if (probe.kind === 'unavailable') {
      // Last-good-state: the candidate stays effective, so its cached trimmed
      // digest must keep occupying the directory's dedup slot — otherwise an
      // identical later sibling would be emitted as a duplicate `set` until the
      // next successful reconciliation removed it again.
      const cached = versions.get(scope)
      if (cached !== undefined && previous !== undefined && previous.action !== 'remove') {
        registerKeptTrimmed(directory, cached.trimmedDigest)
      }
      continue
    }
    if (probe.kind === 'absent') {
      if (previous === undefined || previous.action === 'remove') versions.delete(scope)
      else pushRemoval(scope, previous.path)
      continue
    }
    const { file: probedFile } = probe
    if (seenAbsolutePaths.has(probedFile.absolutePath)) continue
    seenAbsolutePaths.add(probedFile.absolutePath)
    const cached = versions.get(scope)
    if (
      cached !== undefined
      && cached.path === probedFile.displayPath
      && cached.version === probedFile.version
      && previous !== undefined
      && previous.action !== 'remove'
      && previous.path === cached.path
      && previous.digest === cached.digest
    ) {
      // Unchanged and previously rendered: keep it, but an earlier sibling that
      // now matches its trimmed content makes this the duplicate to remove.
      if (registerKeptTrimmed(directory, cached.trimmedDigest)) pushRemoval(scope, previous.path)
      continue
    }

    const file = await readScopeInstruction(probedFile, resolved.maxSourceBytes, fileSystem, options.signal)
    if (file === undefined) continue
    const currentDigest = instructionContentSha1(file.content)
    const trimmedDigest = trimmedInstructionDigest(file.content)
    if (registerKeptTrimmed(directory, trimmedDigest)) {
      // A distinct file whose trimmed content already appeared earlier in this
      // directory: drop it, removing any copy that was previously rendered.
      if (previous !== undefined && previous.action !== 'remove') pushRemoval(scope, previous.path)
      else versions.delete(scope)
      continue
    }
    const nextVersion: InstructionVersionState = {
      path: file.displayPath,
      version: probedFile.version,
      digest: currentDigest,
      trimmedDigest,
    }
    if (previous !== undefined && previous.action !== 'remove' && previous.path === file.displayPath && previous.digest === currentDigest) {
      versions.set(scope, nextVersion)
      continue
    }
    const action = previous === undefined || previous.action === 'remove' ? 'set' : 'replace'
    const change: WorkspaceInstructionChange = {
      action,
      scope,
      path: file.displayPath,
      digest: currentDigest,
    }
    items.push({ change, file })
    versionUpdates.push({ change, state: nextVersion })
  }
  if (items.length === 0) return undefined
  const rendered = renderInstructionChanges(items, resolved.maxBytes)
  if (rendered.text.length === 0 || rendered.changes.length === 0) return undefined
  return {
    context: workspaceContextHook(rendered.text, rendered.changes),
    versionUpdates: retainedInstructionVersionUpdates(versionUpdates, rendered.changes),
  }
}

/**
 * Validate a successful structured file touch and reconcile its applicable scopes.
 * @param agent - optional agent attached to the tool execution.
 * @param exec - completed tool execution descriptor.
 * @param result - original tool result before post-execute decisions.
 * @param resolved - normalized plugin configuration.
 * @param pendingNestedChanges - per-session pending transition maps.
 * @param baselineInstructionStates - retained baseline comparison state.
 * @param versionCache - per-session scope metadata used to skip unchanged reads.
 * @param fileSystem - provider used for current file probes.
 * @returns rendered context plus deferred cache updates, or undefined for irrelevant/failed/unchanged calls.
 */
export async function dynamicInstructionContext(
  agent: Agent | undefined,
  exec: ToolExecution,
  result: ToolExecutionResult,
  resolved: ResolvedConfig,
  pendingNestedChanges: WeakMap<object, Map<string, PendingInstructionChange>>,
  baselineInstructionStates: WeakMap<object, Map<string, WorkspaceInstructionChange>>,
  versionCache: InstructionVersionCache,
  fileSystem: FileSystem,
): Promise<ReconciledInstructionContext | undefined> {
  if (agent === undefined || result.isError) return undefined
  const touchedPath = filePathFromExecution(exec)
  if (touchedPath === undefined) return undefined
  return reconcileInstructionContext(
    agent, resolved, pendingNestedChanges, baselineInstructionStates, versionCache, fileSystem,
    {
      touchedPath,
      includeBaselineScopes: baselineInstructionStates.has(agent.session),
      signal: exec.signal,
    },
  )
}
