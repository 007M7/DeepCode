/**
 * Session-visible workspace instruction state and dynamic reconciliation.
 *
 * @module @deepseek-ai/dsh-workspace-context/state
 */

import type { Agent, HookContext } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import { instructionContentSha1 } from './digest.ts'
import {
  ancestorChain,
  descendantDirsBetween,
  findProjectRoot,
  loadScopeInstruction,
  relativeDisplay,
  type InstructionContentCache,
  type LoadedInstructionFile,
} from './files.ts'
import {
  renderInstructionChanges,
  scopeForDisplayPath,
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
}

/** Plugin-owned raw context with required replay metadata. */
export interface WorkspaceHookContext extends HookContext {
  envelope: 'raw'
  meta: JsonValue
}

function workspaceContextHook(text: string, changes: WorkspaceInstructionChange[]): WorkspaceHookContext {
  const serializedChanges: JsonValue[] = changes.map(change => ({
    action: change.action,
    scope: change.scope,
    path: change.path,
    ...change.previousPath !== undefined ? { previousPath: change.previousPath } : {},
    ...change.digest !== undefined ? { digest: change.digest } : {},
  }))
  const meta: JsonValue = { kind: 'workspace-instructions', version: 1, changes: serializedChanges }
  return { content: [{ type: 'text', text }], source: PLUGIN_SOURCE, envelope: 'raw', meta }
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
    if (value.previousPath !== undefined && typeof value.previousPath !== 'string') continue
    if (value.digest !== undefined && typeof value.digest !== 'string') continue
    changes.push({
      action: value.action,
      scope: value.scope,
      path: value.path,
      ...value.previousPath !== undefined ? { previousPath: value.previousPath } : {},
      ...value.digest !== undefined ? { digest: value.digest } : {},
    })
  }
  return changes
}

function sameInstructionChange(a: WorkspaceInstructionChange, b: WorkspaceInstructionChange): boolean {
  return a.action === b.action && a.scope === b.scope && a.path === b.path && a.digest === b.digest
}

function visibleInstructionChanges(
  agent: Agent,
  pending: Map<string, PendingInstructionChange>,
): Map<string, WorkspaceInstructionChange> {
  const visibleSeqs = new Set(agent.session.surface.nodes.map(node => node.seq))
  const visible = new Map<string, WorkspaceInstructionChange>()
  for (const [seq, event] of agent.session.events.entries()) {
    if (event.type !== 'context/message' || !isWorkspaceContextSource(event.data.source)) continue
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
 * Convert retained baseline files into scope/path/digest comparison state.
 * @param files - baseline files that survived rendering.
 * @returns latest baseline state keyed by logical scope.
 */
export function baselineInstructionChanges(files: LoadedInstructionFile[]): Map<string, WorkspaceInstructionChange> {
  return new Map(files.map((file) => {
    const change: WorkspaceInstructionChange = {
      action: 'set',
      scope: scopeForDisplayPath(file.displayPath),
      path: file.displayPath,
      digest: instructionContentSha1(file.content),
    }
    return [change.scope, change]
  }))
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

function relativeScope(projectRoot: string, dir: string): string {
  const scope = relativeDisplay(projectRoot, dir)
  return scope.length === 0 ? '.' : scope
}

/**
 * Compare visible/pending state with provider-visible files and render transitions.
 * @param agent - session owner whose visible surface supplies durable state.
 * @param resolved - normalized plugin configuration.
 * @param cache - shared provider-version and content-digest cache.
 * @param pendingBySession - short pending window before returned context is logged.
 * @param baselineBySession - frozen baseline comparison state per session.
 * @param fileSystem - provider used for current file probes.
 * @param options - touched path and whether baseline scopes should be checked.
 * @returns a structured context update, or undefined when state is unchanged/unavailable.
 */
export async function reconcileInstructionContext(
  agent: Agent,
  resolved: ResolvedConfig,
  cache: InstructionContentCache,
  pendingBySession: WeakMap<object, Map<string, PendingInstructionChange>>,
  baselineBySession: WeakMap<object, Map<string, WorkspaceInstructionChange>>,
  fileSystem: FileSystem,
  options: { touchedPath?: string; includeBaselineScopes: boolean },
): Promise<WorkspaceHookContext | undefined> {
  const session = agent.session
  const pending = pendingChangesFor(session, pendingBySession)
  const visible = visibleInstructionChanges(agent, pending)
  const effective = new Map(baselineBySession.get(session) ?? [])
  for (const [scope, change] of visible) effective.set(scope, change)
  /* v8 ignore next -- normal agents carry an absolute session cwd. */
  const cwd = session.header.cwd ?? process.cwd()
  const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem)
  const scopes = new Set<string>()
  if (options.includeBaselineScopes) {
    scopes.add('user-global')
    for (const dir of ancestorChain(projectRoot, cwd)) scopes.add(relativeScope(projectRoot, dir))
  }
  for (const scope of effective.keys()) scopes.add(scope)
  if (options.touchedPath !== undefined) {
    for (const dir of descendantDirsBetween(cwd, options.touchedPath)) scopes.add(relativeScope(projectRoot, dir))
  }

  const current = new Map<string, LoadedInstructionFile>()
  const unavailable = new Set<string>()
  const seenAbsolutePaths = new Set<string>()
  for (const scope of scopes) {
    const probe = await loadScopeInstruction(scope, projectRoot, resolved, cache, fileSystem)
    if (probe.kind === 'unavailable') {
      unavailable.add(scope)
      continue
    }
    if (probe.kind === 'absent') continue
    const { file } = probe
    if (seenAbsolutePaths.has(file.absolutePath)) continue
    seenAbsolutePaths.add(file.absolutePath)
    current.set(scope, file)
  }

  const items: ChangeRenderItem[] = []
  for (const scope of scopes) {
    if (unavailable.has(scope)) continue
    const previous = effective.get(scope)
    const file = current.get(scope)
    if (file === undefined) {
      if (previous !== undefined && previous.action !== 'remove') {
        items.push({
          change: { action: 'remove', scope, path: previous.path },
          file: { absolutePath: `removed:${scope}`, displayPath: previous.path, content: '' },
        })
      }
      continue
    }
    const currentDigest = instructionContentSha1(file.content)
    if (previous !== undefined && previous.action !== 'remove' && previous.path === file.displayPath && previous.digest === currentDigest) continue
    const action = previous === undefined || previous.action === 'remove' ? 'set' : 'replace'
    const previousPath = action === 'replace' && previous !== undefined && previous.path !== file.displayPath
      ? previous.path
      : undefined
    items.push({
      change: {
        action,
        scope,
        path: file.displayPath,
        ...previousPath === undefined ? {} : { previousPath },
        digest: currentDigest,
      },
      file,
    })
  }
  if (items.length === 0) return undefined
  const rendered = renderInstructionChanges(items, resolved.maxBytes)
  if (rendered.text.length === 0 || rendered.changes.length === 0) return undefined
  for (const change of rendered.changes) pending.set(change.scope, { change, afterSeq: session.seq })
  return workspaceContextHook(rendered.text, rendered.changes)
}

/**
 * Validate a successful structured file touch and reconcile its applicable scopes.
 * @param agent - optional agent attached to the tool execution.
 * @param exec - completed tool execution descriptor.
 * @param result - original tool result before post-execute decisions.
 * @param resolved - normalized plugin configuration.
 * @param cache - shared provider-version and content-digest cache.
 * @param pendingNestedChanges - per-session pending transition maps.
 * @param baselineInstructionStates - retained baseline comparison state.
 * @param fileSystem - provider used for current file probes.
 * @returns a structured context update, or undefined for irrelevant/failed/unchanged calls.
 */
export async function dynamicInstructionContext(
  agent: Agent | undefined,
  exec: ToolExecution,
  result: ToolExecutionResult,
  resolved: ResolvedConfig,
  cache: InstructionContentCache,
  pendingNestedChanges: WeakMap<object, Map<string, PendingInstructionChange>>,
  baselineInstructionStates: WeakMap<object, Map<string, WorkspaceInstructionChange>>,
  fileSystem: FileSystem,
): Promise<WorkspaceHookContext | undefined> {
  if (agent === undefined || result.isError) return undefined
  const touchedPath = filePathFromExecution(exec)
  if (touchedPath === undefined) return undefined
  return reconcileInstructionContext(
    agent, resolved, cache, pendingNestedChanges, baselineInstructionStates, fileSystem,
    { touchedPath, includeBaselineScopes: baselineInstructionStates.has(agent.session) },
  )
}
