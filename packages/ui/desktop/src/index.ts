/**
 * Shared contracts for the DeepSeek Harness desktop app.
 *
 * The package starts with view and lifecycle contracts so Electron main,
 * preload, and renderer code can evolve without copying product decisions from
 * design notes.
 *
 * @module @deepseek-ai/dsh-desktop
 */

/** Main analysis surfaces in the DeepSeek Harness session view. */
export const DESKTOP_SURFACES = ['chat', 'trajectory', 'waterfall', 'context', 'compare', 'dev'] as const

/** Main analysis surfaces in the DeepSeek Harness session view. */
export type DesktopSurface = (typeof DESKTOP_SURFACES)[number]

/** Right-side inspector tabs, ordered as rendered. */
export const INSPECTOR_TABS = ['input', 'output', 'metadata', 'feedback'] as const

/** Right-side inspector tabs. */
export type InspectorTab = (typeof INSPECTOR_TABS)[number]

/** What a middle surface is primarily for. */
export type SurfacePurpose = 'drive' | 'navigate' | 'timing' | 'request-anatomy' | 'diff' | 'development'

/** Stable class of selectable objects shared by all surfaces. */
export type InspectorTargetKind =
  | 'session'
  | 'run'
  | 'turn'
  | 'step'
  | 'request'
  | 'message'
  | 'assistant-stream'
  | 'tool-call'
  | 'tool-result'
  | 'context-section'
  | 'waterfall-span'
  | 'dev-object'

/** Stable selector fields used to derive view-independent inspector ids. */
export interface InspectorTargetKey {
  readonly sessionId: string
  readonly runId?: string
  readonly kind: InspectorTargetKind
  readonly eventSeq?: number
  readonly syntheticId?: string
}

/** A selected object that can open the inspector drawer. */
export interface InspectorTarget {
  /** Stable view-independent id, usually derived from session id and event seq. */
  readonly id: string
  /** The selected object's normalized kind. */
  readonly kind: InspectorTargetKind
  /** Human-readable title shown in the inspector header. */
  readonly title: string
  /** Optional compact subtitle, such as `turn 1 step 2` or a duration. */
  readonly subtitle?: string
}

/** A visible tab in the inspector for a selected object. */
export interface InspectorTabState {
  readonly tab: InspectorTab
  readonly available: boolean
  readonly summary?: string
  readonly fullPayloadRef?: string
  readonly canCopy: boolean
}

/** Right drawer state. It is absent until the user selects an object. */
export interface InspectorState {
  readonly open: boolean
  readonly target?: InspectorTarget
  readonly activeTab: InspectorTab
  readonly tabs: readonly InspectorTabState[]
}

/** Decides whether the inspector is the right place for complete detail. */
export interface SurfacePolicy {
  /** True when a surface is mainly for navigation, explanation, or comparison. */
  readonly summaryFirst: boolean
  /** True when the surface may show a bounded preview inline. */
  readonly inlinePreview: boolean
  /** True when full raw payloads belong only in the inspector. */
  readonly fullDetailInInspector: boolean
}

/** Static description of one middle surface. */
export interface SurfaceDefinition extends SurfacePolicy {
  readonly id: DesktopSurface
  readonly label: string
  readonly purpose: SurfacePurpose
  readonly primaryQuestion: string
  readonly ownsComposer: boolean
}

/** Lifecycle state for the managed Harness runtime subprocess. */
export type RuntimeState = 'stopped' | 'starting' | 'running' | 'restart-needed' | 'stopping' | 'error'

/** Metadata attached to a run so replay and compare can explain provenance. */
export interface RunArtifact {
  readonly runId: string
  readonly sessionId: string
  readonly createdAt: number
  readonly cwd: string
  readonly gitCommit?: string
  readonly gitDirty?: boolean
  readonly runtimeConfigHash?: string
  readonly parentRunId?: string
  readonly replayOf?: {
    readonly runId: string
    readonly turn?: number
    readonly mode: 'prompt' | 'session-boundary'
  }
}

/** Structural node kinds for the trajectory navigator. */
export type TrajectoryNodeKind =
  | 'session'
  | 'turn'
  | 'step'
  | 'request'
  | 'assistant'
  | 'tool'
  | 'context'
  | 'error'

/** Status shown on structural and timing views. */
export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'

/** A bounded structural row. Full payloads stay in the inspector. */
export interface TrajectoryNode {
  readonly id: string
  readonly kind: TrajectoryNodeKind
  readonly title: string
  readonly status: NodeStatus
  readonly depth: number
  readonly target: InspectorTarget
  readonly eventSeqs: readonly number[]
  readonly preview?: string
  readonly badges?: readonly string[]
  readonly children?: readonly TrajectoryNode[]
}

/** Context sections reconstructed at a selected request boundary. */
export type ContextSectionKind =
  | 'config'
  | 'system'
  | 'message-prefix'
  | 'derived-history'
  | 'context-message'
  | 'steering-message'
  | 'tool-schemas'
  | 'compaction'
  | 'request-delta'

/** Summary row in the Context surface. Full text/schema/JSON is inspector-owned. */
export interface ContextSection {
  readonly id: string
  readonly kind: ContextSectionKind
  readonly title: string
  readonly target: InspectorTarget
  readonly eventSeqs: readonly number[]
  readonly preview?: string
  readonly tokenEstimate?: number
  readonly changedSincePreviousRequest?: boolean
}

/** Timing bar shown in Waterfall. */
export interface WaterfallSpan {
  readonly id: string
  readonly title: string
  readonly target: InspectorTarget
  readonly startMs: number
  readonly durationMs: number
  readonly status: NodeStatus
  readonly parentId?: string
}

/** A user-authored note attached to a stable inspector target. */
export interface FeedbackEntry {
  readonly targetId: string
  readonly author: string
  readonly body: string
  readonly createdAt: number
}

/** Run pair used by Compare. Compare is not scoped to a single session. */
export interface ComparePair {
  readonly baseline: RunArtifact
  readonly candidate: RunArtifact
}

/** First Dev panel shape: agent-assisted modification plus runtime restart. */
export interface DevPanelStatus {
  readonly runtimeState: RuntimeState
  readonly repoDirty: boolean
  readonly restartNeeded: boolean
  readonly watchedPaths: readonly string[]
  readonly suggestedPrompt?: string
}

/** Default author filled into new feedback entries. */
export const DEFAULT_FEEDBACK_AUTHOR = 'shentuni'

/** Default surface definitions for the first Electron implementation. */
export const SURFACE_DEFINITIONS: Record<DesktopSurface, SurfaceDefinition> = {
  chat: {
    id: 'chat',
    label: 'Chat',
    purpose: 'drive',
    primaryQuestion: 'What did the user and agent say, with thinking and tool use folded into readable activity rows?',
    ownsComposer: true,
    summaryFirst: true,
    inlinePreview: true,
    fullDetailInInspector: true,
  },
  trajectory: {
    id: 'trajectory',
    label: 'Trajectory',
    purpose: 'navigate',
    primaryQuestion: 'Where am I in the session, turn, step, request, assistant, tool, and context structure?',
    ownsComposer: true,
    summaryFirst: true,
    inlinePreview: true,
    fullDetailInInspector: true,
  },
  waterfall: {
    id: 'waterfall',
    label: 'Waterfall',
    purpose: 'timing',
    primaryQuestion: 'Where did time go across model requests, tool calls, and failures?',
    ownsComposer: true,
    summaryFirst: true,
    inlinePreview: false,
    fullDetailInInspector: true,
  },
  context: {
    id: 'context',
    label: 'Context',
    purpose: 'request-anatomy',
    primaryQuestion: 'What exactly contributed to the selected model request boundary?',
    ownsComposer: false,
    summaryFirst: true,
    inlinePreview: true,
    fullDetailInInspector: true,
  },
  compare: {
    id: 'compare',
    label: 'Compare',
    purpose: 'diff',
    primaryQuestion: 'How did a candidate replay/run differ from the chosen baseline run?',
    ownsComposer: false,
    summaryFirst: true,
    inlinePreview: true,
    fullDetailInInspector: true,
  },
  dev: {
    id: 'dev',
    label: 'Dev',
    purpose: 'development',
    primaryQuestion: 'Which prompt, tool, plugin, and config artifacts compose the repo-bound Harness agent, and what needs reload after editing?',
    ownsComposer: false,
    summaryFirst: true,
    inlinePreview: true,
    fullDetailInInspector: false,
  },
}

/** Backward-compatible alias for callers that only need policies. */
export const SURFACE_POLICIES: Record<DesktopSurface, SurfacePolicy> = SURFACE_DEFINITIONS

/**
 * Returns whether selecting from a middle surface should open the inspector.
 * @param surface - The active middle surface.
 * @param target - The object the user selected, if any.
 * @returns True when this selection should open the inspector drawer.
 */
export function opensInspector(surface: DesktopSurface, target: InspectorTarget | undefined): boolean {
  return target !== undefined && SURFACE_POLICIES[surface].fullDetailInInspector
}

/**
 * Returns whether the surface participates in the live session composer.
 * @param surface - The active middle surface.
 * @returns True for the three live session surfaces.
 */
export function ownsComposer(surface: DesktopSurface): boolean {
  return SURFACE_DEFINITIONS[surface].ownsComposer
}

/**
 * Full detail belongs in the inspector for trace-analysis surfaces, not the Develop artifact browser.
 * @param surface - The active middle surface.
 * @returns True when raw payloads should live in the inspector for this surface.
 */
export function fullDetailBelongsInInspector(surface: DesktopSurface): boolean {
  return SURFACE_DEFINITIONS[surface].fullDetailInInspector
}

/**
 * Create a stable, view-independent inspector id.
 * @param key - Stable fields that identify the selected object.
 * @returns A colon-delimited target id shared across surfaces.
 */
export function createInspectorTargetId(key: InspectorTargetKey): string {
  const parts = [`session:${key.sessionId}`]
  if (key.runId !== undefined) parts.push(`run:${key.runId}`)
  parts.push(`kind:${key.kind}`)
  if (key.eventSeq !== undefined) parts.push(`seq:${String(key.eventSeq)}`)
  if (key.syntheticId !== undefined) parts.push(`synthetic:${key.syntheticId}`)
  return parts.join(':')
}

/**
 * Pick a useful starting inspector tab for common target kinds.
 * @param target - The selected object that will be inspected.
 * @returns The inspector tab that best matches the target's primary payload.
 */
export function defaultInspectorTabForTarget(target: InspectorTarget): InspectorTab {
  switch (target.kind) {
    case 'assistant-stream':
    case 'tool-result':
      return 'output'
    case 'session':
    case 'run':
    case 'turn':
    case 'step':
    case 'waterfall-span':
      return 'metadata'
    case 'dev-object':
      return 'input'
    default:
      return 'input'
  }
}

/**
 * Build closed drawer state when no node is selected.
 * @returns An inspector state with no target and no visible tabs.
 */
export function closedInspectorState(): InspectorState {
  return {
    open: false,
    activeTab: 'input',
    tabs: [],
  }
}

/**
 * Build an open drawer state for a selected target.
 * @param target - The selected object that owns the inspector content.
 * @returns An open inspector state with the default tab selected.
 */
export function openInspectorState(target: InspectorTarget): InspectorState {
  return {
    open: true,
    target,
    activeTab: defaultInspectorTabForTarget(target),
    tabs: INSPECTOR_TABS.map(tab => ({
      tab,
      available: true,
      canCopy: tab !== 'feedback',
    })),
  }
}
