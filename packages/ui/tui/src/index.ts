/**
 * Interactive pi-tui front door for DeepSeek Harness agents. It renders the
 * durable session transcript, drives one configured agent, and provides
 * keyboard-driven user-interaction dialogs without owning agent lifecycle.
 * @module @deepseek-ai/dsh-tui
 */

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  CombinedAutocompleteProvider,
  Container,
  CURSOR_MARKER,
  Editor,
  Key,
  Spacer,
  Text,
  TUI,
  ProcessTerminal,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type SlashCommand,
  type Terminal,
  type TerminalColorScheme,
} from '@earendil-works/pi-tui'
import { Service, type Context, type Fiber } from 'cordis'
import {
  assembleContextFor,
  installAgentLlmTarget,
  type Agent,
  type AgentLlmTarget,
  type AgentLlmTargetRef,
  type AgentStatus,
  type HookContext,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { renderUnknownXml } from './xml-tool-output.ts'
import type {} from '@deepseek-ai/dsh-llm-retry'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  displayPromptContent,
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import {
  parseSessionReferenceText,
} from '@deepseek-ai/dsh-session-reference'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type {
  SessionLogSnapshot,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
// Type import also declaration-merges the optional `sessionPersistence`
// service onto `Context` so `ctx.get('sessionPersistence')` is typed.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SkillService } from '@deepseek-ai/dsh-skill'
import {
  UserInteractionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-interaction'
import {
  TuiExtensionServiceImpl,
  TuiOverlayManager,
} from './extension/overlay-manager.ts'
import {
  parseTuiPromptTemplate,
  renderTuiPromptTemplate,
  type TuiPromptValueHandle,
} from './prompt.ts'
import type {
  TuiOverlayRequest,
  TuiOverlaySession,
  TuiTheme,
} from './extension/types.ts'
import { displayInlineText, displayText } from './components/text.ts'
import { createPalette, markdownTheme, selectTheme } from './components/theme.ts'
import { contentText, parseArguments } from './components/content.ts'
import {
  cacheHitRate,
  formatTokens,
  recordEventUsage,
  sessionTokens,
} from './session/tokens.ts'
import {
  fadeGlyph,
  formatQueuedStatus,
  openStepPhase,
  openTurn,
  pulseLevel,
  runningPhaseGlyph,
  STATUS_ANIMATION_INTERVAL_MS,
  STATUS_FADE_MS,
  TIMING_BUCKET_GLYPHS,
  type StepPosition,
} from './session/timing.ts'
import {
  resolveTuiConfig,
  type Config,
} from './config.ts'
import {
  HeaderComponent,
  StreamingAssistantComponent,
  ToolCardComponent,
  TodoComponent,
  UserMessageComponent,
} from './components/transcript.ts'
import {
  compactTargetLabel,
  diagnosticMeter,
  formatDiagnosticCount,
  formatDiagnosticNumber,
  formatDiagnosticTime,
  initialTarget,
  ModelDialog,
  QuestionDialog,
  readModelChoices,
  ResumePicker,
  StatusCardComponent,
  PromptContextComponent,
  summarizeResumeCandidate,
  targetLabel,
  targetReasoningLabel,
  type ModelChoice,
  type ModelDialogSelection,
  type ResumeCandidate,
  type StatusCardRow,
} from './components/dialogs.ts'
import {
  parseSkillCommand,
  renderSkillInvocation,
  SKILL_COMMAND_PREFIX,
} from './skill-invocation.ts'
import { ReferenceAutocompleteProvider } from './autocomplete.ts'
import { WorkspaceFileSearch } from './file-autocomplete.ts'

export { TuiPromptService } from './prompt.ts'
export { renderSkillInvocation } from './skill-invocation.ts'
export {
  resolveTuiConfig,
  TuiConfigSchema,
  Config,
  type ResolvedTuiConfig,
  type ResolvedTuiThemeConfig,
  type TuiConfig,
  type TuiThemeConfig,
} from './config.ts'
export {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
} from './file-autocomplete.ts'

export type {
  TuiComponent,
  TuiFocusable,
  TuiOverlayAnchor,
  TuiOverlayCloseReason,
  TuiOverlayHost,
  TuiOverlayMargin,
  TuiOverlayOptions,
  TuiOverlayOutcome,
  TuiOverlayRequest,
  TuiOverlaySession,
  TuiOverlayState,
  TuiTheme,
  TuiViewport,
} from './extension/types.ts'

declare module 'cordis' {
  interface Context {
    /** Terminal-only interaction service, available only while a TUI is mounted. */
    tui: TuiExtensionService
    /** Optional process host that can replace this TUI with a resumed session. */
    tuiResumeHost: TuiResumeHost
  }
}

/** Process-lifecycle owner used by the shipped CLI for an atomic resume handoff. */
export interface TuiResumeHost {
  /**
   * Dispose the current app and replace it with a runtime for `sessionId`.
   * Success does not return. A host may reject before it commits teardown;
   * after commit it owns fatal reporting and process exit.
   * @param sessionId - validated persisted session selected by the user.
   */
  handoff(sessionId: SessionId): Promise<never>
}

/**
 * Optional terminal-local interaction service provided by one mounted TUI.
 *
 * The concrete provider retains pi-tui, focus, and terminal lifecycle state.
 * Plugins receive only effect-owned overlay sessions.
 */
export abstract class TuiExtensionService extends Service {
  /** Exact agent driven by this terminal instance. */
  abstract readonly agent: Agent

  /**
   * Queue an interactive overlay owned by the calling plugin fiber.
   *
   * The TUI displays one overlay at a time in FIFO order. Disposing the caller
   * removes a queued overlay or closes an active one before plugin teardown
   * settles. This live presentation is neither logged nor replayed.
   *
   * @param request - component factory, layout constraints, and cancellation.
   * @returns the effect-owned overlay session.
   * @throws when the TUI has begun shutting down.
   */
  abstract openOverlay(request: TuiOverlayRequest): TuiOverlaySession
}

export const name = 'ui-tui'
export const inject = ['agents', 'sessions', 'commands', 'userInteraction', 'tools', 'llm', 'systemPrompt', 'tokenMeter', 'tuiPrompt']

/** Model guidance for path-only file references selected through the TUI. */
export const FILE_REFERENCE_PROMPT = 'Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.'

/** Runtime boundary used by the interactive TUI. */
export interface TuiRuntime {
  /** Terminal implementation; production uses pi-tui's `ProcessTerminal`. */
  terminal: Terminal
  /** Exit hook used by terminal shutdown or a target-agent startup failure. */
  exit(code: number): void
  /**
   * Override the prompt's logical working-directory label without changing the session directory used by tools.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped label; the TUI makes terminal controls visible.
   */
  formatCwd?: (cwd: string | undefined) => string
  /**
   * Override the Git branch shown in the prompt context line; production resolves it once at mount.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped branch name, or `undefined` outside a Git worktree.
   */
  gitBranch?: (cwd: string) => string | undefined
  /** Monotonic-enough wall clock for elapsed status rendering. Defaults to `Date.now`. */
  now?(): number
  /** Host-owned process handoff; absent leaves `resumeCommand` as the fallback. */
  handoffResume?: TuiResumeHost['handoff']
}

/** Editor that shows a placeholder without making it editable content. */
class HintEditor extends Editor {
  hint: string | undefined
  hintPrefix = ''

  override render(width: number): string[] {
    const lines = super.render(width)
    if (this.hint === undefined || this.getText() !== '') return lines
    const content = lines[0]
    /* v8 ignore next -- Editor always renders one content row. */
    if (content === undefined) return lines
    const padding = ' '.repeat(this.getPaddingX())
    /* v8 ignore next -- the mounted editor is focused whenever its empty-input hint is rendered. */
    const marker = this.focused ? CURSOR_MARKER : ''
    const available = Math.max(0, width - visibleWidth(padding) - visibleWidth(this.hintPrefix))
    const placeholder = truncateToWidth(this.hint, available, '')
    const used = visibleWidth(padding) + visibleWidth(this.hintPrefix) + visibleWidth(placeholder)
    lines[0] = `${padding}${this.hintPrefix}${marker}${placeholder}${' '.repeat(Math.max(0, width - used))}`
    return lines
  }
}

interface RunningStatus {
  turn: number | undefined
  timer: ReturnType<typeof setInterval>
  /** Render clock when the turn began; origin of the glyph fade-in. */
  startedAt: number
  /** The most recently rendered phase glyph, handed to the fade-out. */
  lastGlyph: string
}

/** A running glyph fading out after its turn ended, before the caret returns. */
interface FadingStatus {
  glyph: string
  /** Render clock when the turn ended; origin of the glyph fade-out. */
  endedAt: number
  timer: ReturnType<typeof setInterval>
}

interface PendingQuestion {
  request: AskUserQuestionRequest
  index: number
  answers: AskUserQuestionAnswerItem[]
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: unknown): void
  onAbort: () => void
  overlay: TuiOverlaySession | undefined
}

/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
  /** Stop rendering, restore the terminal, and reject pending questions. */
  dispose(): Promise<void>
}

function formatCwd(cwd: string | undefined): string {
  if (cwd === undefined) return 'cwd unset'
  const home = homedir()
  const rel = relative(resolve(home), resolve(cwd))
  if (rel === '') return '~'
  /* v8 ignore next -- Windows cross-drive coverage; POSIX relative() cannot return an absolute path. */
  if (isAbsolute(rel)) return cwd
  if (rel !== '..' && !rel.startsWith(`..${sep}`)) return `~${sep}${rel}`
  return cwd
}

function gitBranch(cwd: string): string | undefined {
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN)/iu.test(name)),
    )
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).trim()
    /* v8 ignore next -- detached-HEAD behavior is exercised by the runtime smoke, not the unit checkout. */
    return branch === '' ? undefined : branch
  } catch (_gitUnavailableOrOutsideWorktree) {
    return undefined
  }
}

function activeSurfaceSeqs(session: Session): Set<number> {
  return new Set(session.surface.nodes)
}

function sessionReferenceCard(meta: unknown): string[] | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const record = meta as Record<string, unknown>
  if (record['kind'] !== 'session-reference' || !Array.isArray(record['references'])) return undefined
  const references = record['references'] as unknown[]
  const labels: string[] = []
  for (const reference of references) {
    if (typeof reference !== 'object' || reference === null) return undefined
    const entry = reference as Record<string, unknown>
    const sessionId = entry['sessionId']
    const label = entry['label']
    if (typeof sessionId !== 'string' || typeof label !== 'string') return undefined
    labels.push(label === sessionId ? sessionId : `${label} (${sessionId})`)
  }
  return labels
}

function promptReferenceCards(event: Extract<SessionEvent, { type: 'user/message' | 'steering/message' }>): string[][] {
  return event.data.envelope?.prefixContexts.flatMap((context) => {
    const card = sessionReferenceCard(context.meta)
    return card === undefined ? [] : [card]
  }) ?? []
}

function activeToolCallIds(session: Session, active: ReadonlySet<number>): Set<string> {
  const ids = new Set<string>()
  for (const event of session.events) {
    if (event.type !== 'assistant/message' || !active.has(event.seq)) continue
    for (const block of event.data.content) {
      if (block.type === 'tool-call') ids.add(block.id)
    }
  }
  return ids
}

/** Milliseconds between banner sweep-reveal frames (~60 fps). */
const BANNER_REVEAL_INTERVAL_MS = 15

/** Number of sweep frames the banner reveal spreads the terminal width over. */
const BANNER_REVEAL_STEPS = 24

/**
 * Start the interactive pi-tui channel for an already-created target agent.
 * @param ctx - agent, tools, session-event, and user-interaction context.
 * @param config - target agent, banner, and TUI presentation config.
 * @param runtime - terminal and process-exit boundary.
 * @returns lifecycle controller used by the Cordis effect disposer.
 */
export function createTuiChat(
  ctx: Context,
  config: Config,
  runtime: TuiRuntime,
): TuiController {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`ui-tui: session "${sessionId}" is not running`)
  const persistence = ctx.get('sessionPersistence')
  const sessionQuery = ctx.get('sessionQuery')
  const resolved = resolveTuiConfig(config)
  const palette = createPalette(resolved.theme.color)
  const mdTheme = markdownTheme(palette)
  const ui = new TUI(runtime.terminal, resolved.showHardwareCursor)
  const chat = new Container()
  const todoContainer = new Container()
  const inputTemplate = parseTuiPromptTemplate(displayInlineText(resolved.theme.inputPrompt))
  const renderInputPrompt = (): string => renderTuiPromptTemplate(inputTemplate, valueName => ctx.tuiPrompt.get(valueName))
  const initialInputPrompt = renderInputPrompt()
  const editor = new HintEditor(ui, {
    borderColor: palette.dim,
    selectList: selectTheme(palette),
  } satisfies EditorTheme, {
    paddingX: 1,
    frame: 'none',
    prompt: {
      first: initialInputPrompt,
      continuation: ' '.repeat(visibleWidth(initialInputPrompt)),
    },
  })
  editor.hintPrefix = initialInputPrompt
  const todo = new TodoComponent(palette)
  let showReasoning = resolved.showReasoning
  let toolsExpanded = false
  let streaming: StreamingAssistantComponent | undefined
  let completedStreaming: StreamingAssistantComponent | undefined
  let runningStatus: RunningStatus | undefined
  let fadingStatus: FadingStatus | undefined
  // Steering messages queued during the running turn (`agent/inbox/enqueue`
  // with `info.steering`) that the loop has not yet drained, shown as a badge on
  // the status line. Each entry is the queued message's serialized source: a
  // drain (`steering/message`) removes one MATCHING entry, so a loop-authored
  // continuation reason (which enqueues and drains under its own source) pushes
  // and pops its own slot and cannot consume a pending user message's slot.
  // Cleared on leaving `running`, which also absorbs a cancellation that
  // discards the queue without logging drains; the status line exists only
  // while running, so idle carries no badge to keep current.
  const pendingSteering: string[] = []
  let disposed = false
  let shuttingDown: Promise<void> | undefined
  // Optional: skills mount conditionally, so read the global service store
  // rather than declaring an injection that would make the TUI require them.
  const skills = ctx.get('skills')
  const cwd = agent.session.header.cwd ?? process.cwd()
  const fileSearch = new WorkspaceFileSearch(cwd, {
    maxResults: resolved.fileSearchMaxResults,
    maxEntries: resolved.fileSearchMaxEntries,
    excludedDirectories: resolved.fileSearchExcludedDirectories,
  })
  const skillAbort = new AbortController()
  const tokens = sessionTokens(agent.session)
  const toolCards = new Map<string, ToolCardComponent>()
  const allToolCards = new Set<ToolCardComponent>()
  const liveErrors = new Set<string>()
  const questionQueue: PendingQuestion[] = []
  const commandControllers = new Set<AbortController>()
  const referenceControllers = new Set<AbortController>()
  let activeQuestion: PendingQuestion | undefined
  let modelOverlay: TuiOverlaySession | undefined
  let resumeOverlay: TuiOverlaySession | undefined
  let resumeInFlight = false
  let resumeScan = 0
  let tuiServiceFiber: Fiber | undefined
  const target: AgentLlmTargetRef = { current: initialTarget(agent), assembled: undefined }
  let contextWindow: number | undefined
  let contextResolution: Promise<
    | { readonly kind: 'resolved'; readonly contextWindow: number | undefined }
    | { readonly kind: 'error'; readonly error: unknown }
  > | undefined
  let modelCommands = Promise.resolve()
  const now = (): number => runtime.now?.() ?? Date.now()
  const agentStatus = (): AgentStatus => agent.status
  const isDisposed = (): boolean => disposed

  // A configured subtitle renders as a banner line; when absent, the banner has
  // no subtitle. The banner itself sweeps in on start (see startBannerReveal).
  let sessionTitle = foldSessionTitle(agent.session.events)?.title
  const header = new HeaderComponent(
    agent,
    () => sessionTitle ?? config.welcome,
    palette,
    resolved.theme.color && resolved.theme.truecolor,
  )
  const formattedCwd = displayText(runtime.formatCwd?.(agent.session.header.cwd) ?? formatCwd(agent.session.header.cwd))
  const branch = runtime.gitBranch?.(cwd) ?? gitBranch(cwd)
  const promptValues: TuiPromptValueHandle[] = [
    ctx.tuiPrompt.register('cwd', palette.bold(palette.accent(formattedCwd))),
    ctx.tuiPrompt.register('git/worktree', branch === undefined ? undefined : palette.muted(` (${displayText(branch)})`)),
    ctx.tuiPrompt.register('token_meter/cache_hit_rate'),
    ctx.tuiPrompt.register('model'),
    ctx.tuiPrompt.register('context'),
    ctx.tuiPrompt.register('timing'),
    ctx.tuiPrompt.register('symbol', palette.bold(palette.accent('dsh'))),
    ctx.tuiPrompt.register('indicator', palette.muted('> ')),
  ]
  const [cwdValue, gitValue, tokenValue, modelValue, contextValue, timingValue, symbolValue, indicatorValue] = promptValues
  /* v8 ignore next -- the fixed built-in registration list always supplies each handle. */
  if (cwdValue === undefined || gitValue === undefined || tokenValue === undefined || modelValue === undefined
    || contextValue === undefined || timingValue === undefined || symbolValue === undefined || indicatorValue === undefined) {
    throw new Error('TUI prompt built-ins failed to initialize')
  }
  const updatePromptValues = (): void => {
    cwdValue.set(palette.bold(palette.accent(formattedCwd)))
    gitValue.set(branch === undefined ? undefined : palette.muted(` (${displayText(branch)})`))
    const rate = cacheHitRate(tokens)
    const usage = `↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`
    modelValue.set(`  ${palette.muted(displayText(target.current === undefined ? 'model unset' : compactTargetLabel(target.current)))}`)
    tokenValue.set(`  ${palette.muted(rate === undefined ? usage : `${usage}  cache ${rate}%`)}`)
    contextValue.set(contextWindow === undefined ? undefined : `  ${palette.muted(
      `${Math.min(100, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens / contextWindow * 100))}% context`,
    )}`)
    const queued = runningStatus === undefined ? undefined : formatQueuedStatus(pendingSteering.length)
    timingValue.set(queued === undefined ? undefined : palette.dim(queued))
    symbolValue.set(palette.bold(palette.accent('dsh')))
    // `${indicator}` owns the caret column and its trailing gap before the
    // cursor. The phase glyph replaces the `>` caret in place — same width
    // every frame — fading in as a turn starts, throbbing while it runs, and
    // fading out after it ends before the plain `>` returns. Only the gray
    // brightness changes, so the cursor never shifts.
    const runningGlyph = runningPhaseGlyph(agent.session.events, runningStatus !== undefined)
    // Remember the live phase glyph so the fade-out shows it, not the ttft
    // fallback the derivation returns once the closing turn's step has ended.
    if (runningStatus !== undefined && runningGlyph !== undefined) runningStatus.lastGlyph = runningGlyph
    // The fade envelope gates appear/disappear; the running throb breathes the
    // glyph the whole turn. Truecolor opacity is envelope × throb; the
    // non-truecolor fallback keys visibility off the envelope alone, so the
    // throb never blinks it. `envelope` clamps to [0, 1].
    const envelope = runningStatus !== undefined && runningGlyph !== undefined
      ? { glyph: runningGlyph, level: Math.min(1, (now() - runningStatus.startedAt) / STATUS_FADE_MS) }
      : fadingStatus !== undefined
        ? { glyph: fadingStatus.glyph, level: Math.max(0, 1 - (now() - fadingStatus.endedAt) / STATUS_FADE_MS) }
        : undefined
    const caret = envelope === undefined
      ? palette.muted('>')
      : fadeGlyph(
        envelope.glyph,
        palette,
        resolved.theme.color,
        resolved.theme.color && resolved.theme.truecolor,
        envelope.level * pulseLevel(now()),
        envelope.level >= 0.5,
      )
    indicatorValue.set(`${caret}${palette.muted(' ')}`)
  }
  updatePromptValues()
  const promptContext = new PromptContextComponent(
    parseTuiPromptTemplate(displayInlineText(resolved.theme.leftPrompt)),
    parseTuiPromptTemplate(displayInlineText(resolved.theme.rightPrompt)),
    valueName => ctx.tuiPrompt.get(valueName),
  )
  ui.addChild(header)
  ui.addChild(chat)
  ui.addChild(new Spacer(1))
  todoContainer.addChild(todo)
  ui.addChild(todoContainer)
  ui.addChild(promptContext)
  ui.addChild(editor)
  ui.setFocus(editor)
  const updateTerminalTitle = (): void => {
    runtime.terminal.setTitle(displayText(
      sessionTitle === undefined ? resolved.title : `${sessionTitle} — ${resolved.title}`,
    ))
  }
  updateTerminalTitle()

  const requestRender = (): void => {
    if (disposed) return
    updatePromptValues()
    const inputPrompt = renderInputPrompt()
    editor.setPrompt({ first: inputPrompt, continuation: ' '.repeat(visibleWidth(inputPrompt)) })
    editor.hintPrefix = inputPrompt
    promptContext.invalidate()
    ui.requestRender()
  }
  // A prompt value that changes on its own schedule (e.g. a plugin-owned
  // `${custom}` fragment) redraws through the registry's coalesced notification;
  // built-ins are already covered by the state-change callers of requestRender.
  const disposePromptChanges = ctx.tuiPrompt.subscribe(requestRender)

  const appendNotice = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
    const color = kind === 'error' ? palette.error : kind === 'warning' ? palette.warning : palette.muted
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(color(displayText(message)), 0, 0))
    requestRender()
  }

  const extensionTheme: TuiTheme = Object.freeze({
    text: (value: string) => palette.text(value),
    muted: (value: string) => palette.muted(value),
    dim: (value: string) => palette.dim(value),
    accent: (value: string) => palette.accent(value),
    success: (value: string) => palette.success(value),
    warning: (value: string) => palette.warning(value),
    error: (value: string) => palette.error(value),
    bold: (value: string) => palette.bold(value),
  })
  const overlayManager = new TuiOverlayManager({
    viewport: () => Object.freeze({
      columns: runtime.terminal.columns,
      rows: runtime.terminal.rows,
    }),
    theme: () => extensionTheme,
    display: displayText,
    show: (component, options) => ui.showOverlay(component, options === undefined
      ? undefined
      : {
        ...options,
        ...typeof options.margin === 'object'
          ? { margin: { ...options.margin } }
          : {},
      }),
    invalidate: requestRender,
    reportError: (error) => {
      const message = errorChain(error)
      ctx.logger.warn(`ui-tui: overlay failed: ${message}`)
      /* v8 ignore next -- shutdown removes overlays before the terminal stops */
      if (disposed) return
      appendNotice(`TUI overlay failed: ${message}`, 'error')
    },
  })

  const disposeTargetListeners = installAgentLlmTarget(agent.ctx, target)

  const resolveContextWindow = (selected: AgentLlmTarget | undefined): void => {
    contextWindow = undefined
    const resolution = selected === undefined
      ? Promise.resolve({ kind: 'resolved', contextWindow: undefined } as const)
      : ctx.llm.resolveModelInfo(selected.provider, selected.model).then(
        info => ({ kind: 'resolved', contextWindow: info.context?.contextWindow } as const),
        (error: unknown) => ({ kind: 'error', error } as const),
      )
    contextResolution = resolution
    void resolution.then((result) => {
      if (contextResolution !== resolution) return
      if (result.kind === 'error') {
        appendNotice(`Could not resolve model context: ${errorChain(result.error)}`, 'error')
        return
      }
      contextWindow = result.contextWindow
      requestRender()
    })
  }
  resolveContextWindow(target.current)

  const selectModel = (
    selected: ModelChoice,
    explicitReasoning?: { effort: ReasoningEffortId | undefined },
  ): void => {
    const sameRoute = target.current?.provider === selected.provider && target.current.model === selected.model
    const reasoningEffort = explicitReasoning === undefined
      ? (sameRoute ? target.current?.reasoningEffort ?? selected.reasoning?.defaultEffort : selected.reasoning?.defaultEffort)
      : explicitReasoning.effort
    if (sameRoute && target.current?.reasoningEffort === reasoningEffort) {
      const reasoning = targetReasoningLabel(selected, reasoningEffort)
      appendNotice(`Model is already ${targetLabel(selected)}${reasoning === undefined ? '' : ` with reasoning effort ${displayText(reasoning)}`}.`)
      return
    }
    target.current = {
      provider: selected.provider,
      model: selected.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }
    resolveContextWindow(target.current)
    const reasoning = targetReasoningLabel(selected, reasoningEffort)
    appendNotice([
      `Model selected: ${targetLabel(selected)}.`,
      ...reasoning === undefined ? [] : [`Reasoning effort: ${displayText(reasoning)}.`],
      'New steps will use it.',
    ].join(' '))
  }

  const showModelSelector = (choices: readonly ModelChoice[]): void => {
    const current = target.current === undefined ? 'unset' : targetLabel(target.current)
    if (choices.length === 0) {
      appendNotice(`Current model: ${current}\nNo models are advertised by registered providers.`, 'warning')
      return
    }
    void modelOverlay?.close()
    const session = overlayManager.open({
      create: () => new ModelDialog(
        choices,
        target.current,
        resolved.maxModelOptions,
        palette,
        (selection: ModelDialogSelection) => {
          void session.close()
          selectModel(selection.choice, { effort: selection.reasoningEffort })
        },
        () => { void session.close() },
      ),
      options: {
        width: resolved.modelDialogWidth,
        maxHeight: resolved.modelDialogMaxHeight,
        anchor: 'center',
        margin: 1,
      },
    })
    modelOverlay = session
    void session.closed.then(() => {
      if (modelOverlay === session) modelOverlay = undefined
    })
    requestRender()
  }

  const handleModelCommand = async (raw: string): Promise<void> => {
    const choices = await readModelChoices(ctx, target.current)
    if (disposed) return
    const argument = raw.trim()
    if (argument === '') {
      showModelSelector(choices)
      return
    }
    const parts = argument.split(/\s+/u)
    if (parts.length > 2) {
      appendNotice('Usage: /model [provider/]model', 'warning')
      return
    }

    let matches: ModelChoice[]
    if (parts.length === 2) {
      matches = choices.filter(choice => choice.provider === parts[0] && choice.model === parts[1])
    } else {
      const value = argument
      const qualified = choices.filter(choice => targetLabel(choice) === value)
      matches = qualified.length > 0 ? qualified : choices.filter(choice => choice.model === value)
    }
    if (matches.length === 0) {
      appendNotice(`Unknown model: ${argument}. Run /model to list available models.`, 'warning')
      return
    }
    if (matches.length > 1) {
      appendNotice(`Model "${argument}" is advertised by multiple providers; use /model <provider>/<model>.`, 'warning')
      return
    }
    const selected = matches[0]
    /* v8 ignore next -- a non-empty matches array always has index zero. */
    if (selected === undefined) return
    selectModel(selected)
  }

  const queueModelCommand = (raw: string): void => {
    modelCommands = modelCommands.then(async () => {
      await handleModelCommand(raw)
    }).catch((error: unknown) => {
      if (!disposed) appendNotice(`Could not read the model catalog: ${errorChain(error)}`, 'error')
    })
  }

  const renderStatus = (): void => {
    streaming?.invalidate()
    requestRender()
  }

  /** Stop the running and fade-out timers and drop both states at once. */
  const clearStatus = (): void => {
    if (runningStatus !== undefined) {
      clearInterval(runningStatus.timer)
      runningStatus = undefined
    }
    if (fadingStatus !== undefined) {
      clearInterval(fadingStatus.timer)
      fadingStatus = undefined
    }
    runtime.terminal.setProgress(false)
  }

  /**
   * On the running → non-running edge, hand the last rendered glyph to a
   * fade-out that re-renders until it settles on the `>` caret, then stops its
   * own timer. A hard clear (teardown) skips this via {@link clearStatus}.
   */
  const beginFadeOut = (glyph: string): void => {
    clearStatus()
    const fading: FadingStatus = {
      glyph,
      endedAt: now(),
      timer: setInterval(() => {
        if (now() - fading.endedAt >= STATUS_FADE_MS) clearStatus()
        renderStatus()
      }, STATUS_ANIMATION_INTERVAL_MS),
    }
    fadingStatus = fading
  }

  const setStatus = (status: AgentStatus): void => {
    const priorTurn = runningStatus?.turn
    const fadeOutGlyph = status !== 'running' ? runningStatus?.lastGlyph : undefined
    if (status === 'running') clearStatus()
    else if (fadeOutGlyph !== undefined) beginFadeOut(fadeOutGlyph)
    else clearStatus()
    editor.borderColor = status === 'running' ? text => palette.accent(text) : text => palette.dim(text)
    editor.hint = status === 'running' ? palette.dim(displayInlineText(resolved.theme.inputPlaceholder)) : undefined
    if (status === 'running') {
      const turn = priorTurn ?? openTurn(agent.session.events)
      const running: RunningStatus = {
        turn,
        startedAt: now(),
        // Seed with the current phase (ttft before the first step opens) so the
        // fade-out always has a glyph, even for a turn that ends before a render.
        lastGlyph: TIMING_BUCKET_GLYPHS[openStepPhase(agent.session.events) ?? 'ttft'],
        // Refresh every tick so the fading prompt phase glyph animates even
        // before the first token, when no streaming component exists yet.
        timer: setInterval(renderStatus, STATUS_ANIMATION_INTERVAL_MS),
      }
      runningStatus = running
      runtime.terminal.setProgress(true)
    }
    requestRender()
  }

  const refreshStatus = (): void => {
    renderStatus()
  }

  const parsedTool = (event: Extract<SessionEvent, { type: 'tool/call' }>): ToolCardComponent => {
    const parsed = parseArguments(event.data.arguments)
    const card = new ToolCardComponent(
      event.data.name,
      parsed,
      ctx.tools.get(event.data.name, agent),
      resolved.maxToolOutputLines,
      palette,
      mdTheme,
    )
    card.setExpanded(toolsExpanded)
    toolCards.set(event.data.callId, card)
    allToolCards.add(card)
    return card
  }

  const removeStreaming = (current: StreamingAssistantComponent | undefined): void => {
    if (current === undefined) return
    for (const child of [current, current.timing]) {
      const index = chat.children.indexOf(child)
      /* v8 ignore next -- streaming components and their timing footers are retained only while attached to the chat. */
      if (index >= 0) chat.children.splice(index, 1)
    }
  }

  /**
   * Move the running step's timing footer to the tail of the chat so it trails
   * the tool cards the step just appended. A completed footer (its step ended,
   * so `streaming` is cleared) stays pinned where it is.
   */
  const trailStreamingTiming = (): void => {
    /* v8 ignore next -- every replayed tool event follows its step/start, so an open step always owns an attached footer here. */
    if (streaming === undefined) return
    const footer = streaming.timing
    const index = chat.children.indexOf(footer)
    /* v8 ignore next -- the open step's footer is attached to the chat whenever a tool event of that step renders. */
    if (index < 0) return
    chat.children.splice(index, 1)
    chat.addChild(footer)
  }

  const clearStreaming = (): void => {
    removeStreaming(streaming)
    streaming = undefined
  }

  const retractFailedStreaming = (): void => {
    removeStreaming(streaming ?? completedStreaming)
    streaming = undefined
    completedStreaming = undefined
  }

  const startAssistantStep = (position: StepPosition): void => {
    streaming = new StreamingAssistantComponent(
      position,
      () => agent.session.events,
      now,
      showReasoning,
      palette,
      mdTheme,
    )
    chat.addChild(streaming)
    chat.addChild(streaming.timing)
  }

  const renderEvent = (
    event: SessionEvent,
    options: {
      addHistory: boolean
      renderChunks: boolean
    },
  ): void => {
    switch (event.type) {
      case 'user/message': {
        // Injected context (plugin/goal source) renders as a dim context card,
        // not a human bubble; only a direct human prompt is a user message. The
        // boolean avoids narrowing `source`, so the label keeps its full union.
        const source = event.data.source
        if (source.kind !== 'user') {
          const references = sessionReferenceCard(event.data.meta)
          if (references !== undefined) {
            chat.addChild(new Spacer(1))
            chat.addChild(new Text(palette.dim(`Referenced sessions · ${references.map(displayText).join(', ')}`), 0, 0))
            break
          }
          const text = contentText(event.data.content).trim()
          /* v8 ignore next -- context events with empty content are rejected by their owning producers. */
          if (text) {
            // The tui type view lacks plugin-augmented source kinds (e.g. goal),
            // so read the display label without narrowing on `kind`.
            const labelled = source as { kind: string; plugin?: string }
            /* v8 ignore next -- current plugin-augmented context sources always carry their display label. */
            const label = labelled.plugin ?? labelled.kind
            const xml = renderUnknownXml(
              text,
              resolved.maxToolOutputLines,
              true,
              displayText,
              value => palette.muted(value),
              /* v8 ignore next -- expanded context XML never asks renderUnknownXml for a collapsed summary. */
              () => '',
            )
            chat.addChild(new Spacer(1))
            chat.addChild(new Text(palette.dim(`Context · ${displayText(label)}`), 0, 0))
            chat.addChild(new Text(xml?.join('\n') ?? palette.muted(displayText(text)), 0, 0))
          }
          break
        }
        const text = displayText(contentText(displayPromptContent(event.data)).trim())
        if (text) {
          chat.addChild(new Spacer(1))
          chat.addChild(new UserMessageComponent(text, palette, mdTheme))
          if (options.addHistory) editor.addToHistory(text)
        }
        for (const references of promptReferenceCards(event)) {
          chat.addChild(new Spacer(1))
          chat.addChild(new Text(palette.dim(`Referenced sessions · ${references.map(displayText).join(', ')}`), 0, 0))
        }
        break
      }
      case 'steering/message': {
        const text = displayText(contentText(displayPromptContent(event.data)).trim())
        if (text) {
          chat.addChild(new Spacer(1))
          chat.addChild(new UserMessageComponent(text, palette, mdTheme, 'Steering'))
        }
        for (const references of promptReferenceCards(event)) {
          chat.addChild(new Spacer(1))
          chat.addChild(new Text(palette.dim(`Referenced sessions · ${references.map(displayText).join(', ')}`), 0, 0))
        }
        break
      }

      case 'prompt/blocked':
        appendNotice(`Prompt blocked: ${event.data.reason}`, 'warning')
        break
      case 'step/start':
        startAssistantStep(event.data)
        break
      case 'assistant/chunk':
        if (options.renderChunks) streaming?.update(event.data.chunk)
        break
      case 'assistant/message':
        completedStreaming = undefined
        if (streaming === undefined || !chat.children.includes(streaming)) startAssistantStep(event.data)
        streaming?.settle(event.data.content)
        break
      case 'llm/retry': {
        retractFailedStreaming()
        appendNotice(
          `Retrying model request (${event.data.retry}/${event.data.maxRetries}) in ${event.data.delayMs}ms: ${event.data.failure.message}`,
          'warning',
        )
        break
      }
      case 'tool/call':
        chat.addChild(new Spacer(1))
        chat.addChild(parsedTool(event))
        trailStreamingTiming()
        break
      case 'tool/result': {
        let card = toolCards.get(event.data.callId)
        if (card === undefined) {
          card = new ToolCardComponent('tool', { value: {}, valid: true }, undefined, resolved.maxToolOutputLines, palette, mdTheme)
          chat.addChild(new Spacer(1))
          chat.addChild(card)
          allToolCards.add(card)
        }
        card.updateResult(event.data)
        toolCards.delete(event.data.callId)
        trailStreamingTiming()
        break
      }
      case 'todo/write':
        todo.update(event.data.todos)
        break
      case 'session/title':
        sessionTitle = event.data.title
        header.invalidate()
        updateTerminalTitle()
        break
      case 'step/end':
        if (streaming === undefined) startAssistantStep(event.data)
        streaming?.complete(event.time)
        completedStreaming = streaming
        streaming = undefined
        break
      // Every turn/end kind presents why the agent stopped: `completed` is
      // presented by the settled assistant message and its Completed timing
      // header; every other kind appends an explicit notice.
      case 'turn/end': {
        clearStreaming()
        const reason = event.data.reason
        switch (reason.kind) {
          case 'completed':
            break
          case 'error': {
            const key = `${event.data.turn}:${reason.step}`
            const message = 'failure' in reason ? reason.failure.message : reason.message
            if (!liveErrors.delete(key)) appendNotice(message, 'error')
            break
          }
          case 'aborted':
            appendNotice('Turn cancelled.', 'warning')
            break
          case 'max-tokens':
            appendNotice('The model reached its output-token limit.', 'warning')
            break
          case 'rejected':
            appendNotice(`Turn rejected: ${reason.reason}`, 'warning')
            break
          case 'disposed':
            appendNotice('Turn stopped: the agent was disposed.', 'warning')
            break
          case 'interrupted':
            appendNotice('The previous process ended during this turn.', 'warning')
            break
          default:
            // TurnEndReasonMap is merge-extensible: a plugin-added outcome
            // still names why the agent stopped rather than ending silently.
            appendNotice(`Turn ended: ${(reason as { kind: string }).kind}.`, 'warning')
            break
        }
        break
      }
      default:
        break
    }
  }

  const rebuildTranscript = (populateHistory: boolean): void => {
    chat.clear()
    toolCards.clear()
    allToolCards.clear()
    streaming = undefined
    const active = activeSurfaceSeqs(agent.session)
    const activeCalls = activeToolCallIds(agent.session, active)
    for (const event of agent.session.events) {
      const isSurface = event.type === 'user/message'
        || event.type === 'assistant/message'
        || event.type === 'tool/result'
        || event.type === 'steering/message'
      if (isSurface && !active.has(event.seq)) continue
      if (event.type === 'tool/call' && !activeCalls.has(event.data.callId)) continue
      renderEvent(event, { addHistory: populateHistory, renderChunks: false })
    }
    requestRender()
  }

  const removeAbortListener = (pending: PendingQuestion): void => {
    pending.request.signal?.removeEventListener('abort', pending.onAbort)
  }

  const rejectQuestion = (pending: PendingQuestion): void => {
    void pending.overlay?.close()
    pending.overlay = undefined
    removeAbortListener(pending)
    pending.reject(new UserInteractionError(
      'ask_user_question was interrupted before the user answered',
      'ASK_ABORTED',
    ))
  }

  const startNextQuestion = (): void => {
    if (activeQuestion !== undefined || disposed) return
    const pending = questionQueue.shift()
    if (pending === undefined) return
    activeQuestion = pending
    const show = (): void => {
      const question = pending.request.questions[pending.index]
      if (question === undefined) {
        activeQuestion = undefined
        removeAbortListener(pending)
        pending.resolve({ answers: pending.answers })
        startNextQuestion()
        return
      }
      const session = overlayManager.open({
        ...pending.request.signal === undefined ? {} : { signal: pending.request.signal },
        create: () => new QuestionDialog(
          question,
          pending.index + 1,
          pending.request.questions.length,
          pending.request.questions.length - pending.answers.length,
          resolved.maxQuestionOptions,
          palette,
          (selection) => {
            pending.overlay = undefined
            void session.close()
            pending.answers.push({ id: question.id, ...selection })
            pending.index += 1
            show()
          },
          () => {
            activeQuestion = undefined
            rejectQuestion(pending)
            startNextQuestion()
          },
        ),
        options: {
          width: resolved.questionDialogWidth,
          maxHeight: resolved.questionDialogMaxHeight,
          anchor: 'bottom-left',
          margin: { bottom: 1 },
        },
      })
      pending.overlay = session
      void session.closed.then((result) => {
        if (pending.overlay !== session) return
        pending.overlay = undefined
        /* v8 ignore next 2 -- close, abort, and shutdown settle the owner before this callback */
        if (result.reason !== 'error') return
        activeQuestion = undefined
        removeAbortListener(pending)
        pending.reject(new UserInteractionError(
          `ask_user_question TUI failed: ${errorChain(result.error)}`,
          'ASK_ABORTED',
        ))
        startNextQuestion()
      })
      requestRender()
    }
    show()
  }

  const disposeUserInteraction = ctx.userInteraction.registerProvider({
    ask(request) {
      return new Promise<AskUserQuestionAnswer>((resolveAnswer, reject) => {
        const pending: PendingQuestion = {
          request,
          index: 0,
          answers: [],
          resolve: resolveAnswer,
          reject,
          overlay: undefined,
          onAbort: () => {
            if (activeQuestion === pending) {
              activeQuestion = undefined
              rejectQuestion(pending)
              startNextQuestion()
              return
            }
            // A non-active pending ask remains in the queue until this listener settles it.
            questionQueue.splice(questionQueue.indexOf(pending), 1)
            rejectQuestion(pending)
          },
        }
        request.signal?.addEventListener('abort', pending.onAbort, { once: true })
        questionQueue.push(pending)
        startNextQuestion()
      })
    },
  })

  /**
   * Persisted sessions for this workspace, newest first. Empty when no
   * persistence backend is mounted or a listing failure would otherwise block
   * exit or crash `/resume`; the resume hint is best-effort convenience.
   */
  const listWorkspaceSessions = async (): Promise<SessionHeader[]> => {
    if (persistence === undefined) return []
    let all: readonly SessionHeader[]
    try {
      all = await persistence.list()
    } catch {
      // A listing failure must never block terminal exit or crash `/resume`.
      return []
    }
    return all
      .filter(header => header.cwd === agent.session.header.cwd)
  }

  /**
   * The resume command for the current session — the configured template with
   * every `{session}` filled — but only once the session is durably persisted,
   * so a session abandoned before its first flush yields no hint (resuming that
   * id would fail to load).
   */
  const currentResumeCommand = async (): Promise<string | undefined> => {
    if (config.resumeCommand === undefined) return undefined
    const sessions = await listWorkspaceSessions()
    if (!sessions.some(header => header.id === agent.session.id)) return undefined
    return config.resumeCommand.replaceAll('{session}', agent.session.id)
  }

  const shutdown = (exitProcess: boolean): Promise<void> => {
    shuttingDown ??= (async () => {
      disposed = true
      overlayManager.beginShutdown()
      contextResolution = undefined
      clearStatus()
      for (const controller of commandControllers) controller.abort(new Error('TUI disposed'))
      commandControllers.clear()
      for (const controller of referenceControllers) controller.abort(new Error('TUI disposed'))
      referenceControllers.clear()
      await tuiServiceFiber?.dispose()
      tuiServiceFiber = undefined
      if (activeQuestion !== undefined) {
        const pending = activeQuestion
        activeQuestion = undefined
        rejectQuestion(pending)
      }
      for (const pending of questionQueue.splice(0)) rejectQuestion(pending)
      await overlayManager.dispose()
      modelOverlay = undefined
      disposeUserInteraction()
      await runtime.terminal.drainInput(100, 20)
      ui.stop()
      if (exitProcess) {
        const command = await currentResumeCommand()
        if (command !== undefined) {
          runtime.terminal.write(`${palette.muted('To resume this session:')} ${displayText(command)}\n`)
        }
        runtime.exit(0)
      }
    })()
    return shuttingDown
  }

  const requestExit = (): void => {
    if (agent.status === 'running') {
      agent.cancel({ kind: 'user' })
      appendNotice('Cancelling the active turn before exit…', 'warning')
      void agent.whenIdle().then(() => shutdown(true))
      return
    }
    void shutdown(true)
  }

  /** Swap the palette and all derived themes for the given terminal color scheme. */
  const applyColorScheme = (scheme: TerminalColorScheme): void => {
    if (scheme === currentScheme) return
    currentScheme = scheme
    Object.assign(palette, createPalette(resolved.theme.color, scheme))
    Object.assign(mdTheme, markdownTheme(palette))
    // `setStatus` below re-derives `editor.borderColor` from the new palette.
    rebuildTranscript(false)
    setStatus(agent.status)
    requestRender()
  }
  let currentScheme: TerminalColorScheme = 'dark'

  // Apply any color scheme the terminal reports. Registering before the query
  // below means even a synchronous reply reaches `applyColorScheme`; in practice
  // the startup query's reply is the only report, since dsh-tui leaves
  // unsolicited color-scheme notifications disabled.
  const disposeSchemeListener = ui.onTerminalColorSchemeChange(applyColorScheme)

  // Ask the terminal for its color scheme via device-status report; the reply,
  // if any, arrives through the listener above. Most terminals do not respond,
  // so we keep the dark-optimised palette. Swallow a query-write failure for the
  // same reason.
  ui.queryTerminalColorScheme({ timeoutMs: 2000 }).catch(() => {})

  const toggleTools = (): void => {
    toolsExpanded = !toolsExpanded
    for (const card of allToolCards) card.setExpanded(toolsExpanded)
    appendNotice(`Tool cards ${toolsExpanded ? 'expanded' : 'collapsed'}.`)
  }

  const toggleReasoning = (): void => {
    showReasoning = !showReasoning
    const activeStreaming = streaming
    rebuildTranscript(false)
    /* v8 ignore next -- the non-streaming command path is covered; this branch preserves an active stream across rebuild. */
    if (activeStreaming !== undefined) {
      streaming = activeStreaming
      streaming.setShowReasoning(showReasoning)
      chat.addChild(activeStreaming)
      chat.addChild(activeStreaming.timing)
    }
    appendNotice(`Reasoning blocks ${showReasoning ? 'shown' : 'hidden'}.`)
  }

  const showHelp = (): void => {
    const commandLines = ctx.commands.list(agent).map((command) => {
      const input = command.input === undefined ? '' : ` ${command.input.hint}`
      return `/${command.name}${input} — ${command.description}`
    })
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Keyboard shortcuts')), 0, 0))
    chat.addChild(new Text([
      'Enter send • Shift/Alt+Enter newline • Up/Down prompt history',
      'Esc cancel active turn • Ctrl+O toggle tool cards • Ctrl+R toggle reasoning',
      'Ctrl+C cancel while running; clear input or exit while idle • Ctrl+D exit',
      '',
      ...commandLines,
      '/skill:<name> [instructions] — load a skill into the conversation',
    ].map(line => palette.muted(line)).join('\n'), 0, 0))
    requestRender()
  }

  const showStatus = async (signal: AbortSignal): Promise<void> => {
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    /* v8 ignore next -- disposal during the awaited assembly is covered by command-owner teardown tests. */
    if (disposed) return
    /* v8 ignore next -- SystemPrompt always emits at least its required base section. */
    const systemPrompt = displayText(renderPrompt(assembly)) || '(empty)'
    const registeredTools = assembly.tools.map(tool => displayText(tool.name)).join(', ') || '(none)'
    const events = agent.session.events
    const latestActivity = events.at(-1)?.time ?? agent.session.header.createdAt
    const usedContext = Math.max(0, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens))
    let context = `${formatDiagnosticNumber(usedContext)} used · capacity unknown`
    if (contextWindow !== undefined) {
      const contextPercent = Math.round(usedContext / contextWindow * 100)
      context = `${diagnosticMeter(contextPercent, palette)} ${String(contextPercent)}% used (${formatDiagnosticNumber(usedContext)} / ${formatDiagnosticNumber(contextWindow)})`
    }
    const rate = cacheHitRate(tokens)
    const turns = events.filter(event => event.type === 'turn/start').length
    const steps = events.filter(event => event.type === 'step/start').length
    const toolCalls = events.filter(event => event.type === 'tool/call').length
    const model = target.current === undefined ? 'unset' : displayText(targetLabel(target.current))
    const effort = target.current === undefined
      ? 'unset'
      : target.current.reasoningEffort === undefined
        ? 'default'
        : displayText(target.current.reasoningEffort)
    const groups: readonly (readonly StatusCardRow[])[] = [
      [
        ['Session', displayText(agent.session.id)],
        ['Title', displayText(sessionTitle ?? 'untitled')],
        ['Directory', displayText(cwd)],
        ['Model', `${model} ${palette.dim(`(effort ${effort}; reasoning blocks ${showReasoning ? 'shown' : 'hidden'})`)}`],
      ],
      [
        ['Agent', [
          agent.status,
          formatDiagnosticCount(events.length, 'event'),
          formatDiagnosticCount(turns, 'turn'),
          formatDiagnosticCount(steps, 'step'),
          formatDiagnosticCount(toolCalls, 'tool call'),
        ].join(' · ')],
      ],
      [
        ['Tokens', `${formatDiagnosticNumber(tokens.input)} input + ${formatDiagnosticNumber(tokens.output)} output`],
        ['KV cache', rate === undefined
          ? `n/a (${formatDiagnosticNumber(tokens.cacheRead)} read + ${formatDiagnosticNumber(tokens.cacheWrite)} write)`
          : `${diagnosticMeter(rate, palette)} ${String(rate)}% hit (${formatDiagnosticNumber(tokens.cacheRead)} read + ${formatDiagnosticNumber(tokens.cacheWrite)} write)`],
        ['Context', context],
      ],
      [
        ['Created', formatDiagnosticTime(agent.session.header.createdAt)],
        ['Active', formatDiagnosticTime(latestActivity)],
      ],
    ]
    const card = new StatusCardComponent(groups, palette)
    chat.addChild(new Spacer(1))
    chat.addChild(card)
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('System prompt')), 0, 0))
    chat.addChild(new Text(systemPrompt, 0, 0))
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Registered tools')), 0, 0))
    chat.addChild(new Text(registeredTools, 0, 0))
    requestRender()
  }

  // Skill listing is async while `createTuiChat` is synchronous, so the
  // completions rebuild once the catalog resolves. Disabled-for-model skills
  // are absent from `list()`, so they never appear as completions; a user can
  // still invoke one by typing its exact name.
  let skillCommands: SlashCommand[] = []
  const refreshCommandAutocomplete = (): void => {
    const base = new CombinedAutocompleteProvider(
      [
        ...ctx.commands.list(agent).map(command => ({
          name: command.name,
          description: command.description,
          ...(command.input === undefined ? {} : { argumentHint: command.input.hint }),
        })),
        ...skillCommands,
      ],
      agent.session.header.cwd ?? process.cwd(),
    )
    const sessionReferences = ctx.get('sessionReferences')
    editor.setAutocompleteProvider(new ReferenceAutocompleteProvider(
      base,
      fileSearch,
      sessionReferences,
      agent,
    ))
  }
  const disposeCommandChanges = ctx.on('commands/change', refreshCommandAutocomplete)
  refreshCommandAutocomplete()

  const loadSkillCommands = (service: SkillService): void => {
    service.list({ cwd, signal: skillAbort.signal }).then(
      (summaries) => {
        if (disposed || summaries.length === 0) return
        // The argument-hint slot shows in the menu but is never inserted on
        // selection, so it carries the skill's scope instead of an
        // instructions placeholder. `SkillSource` is open-ended; every
        // non-project source (user, custom, bundled, runtime, …) collapses
        // to `(user)`.
        skillCommands = summaries.map(skill => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          argumentHint: skill.source.startsWith('project-') ? '(project)' : '(user)',
        }))
        refreshCommandAutocomplete()
        requestRender()
      },
      () => {
        // Discovery failed or was aborted on dispose; keep the base slash
        // commands so autocomplete still works without skill entries.
      },
    )
  }
  if (skills !== undefined) loadSkillCommands(skills)

  // The agent scope is minted by agent-loop and intentionally inherits only
  // that core plugin's dependencies. A child command producer declares its own
  // UI-service dependency while retaining the parent agent scope and lifetime.
  const commandFiber = agent.ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'help',
      description: 'Show keyboard shortcuts and commands',
      handler: () => { showHelp(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'model',
      description: 'Show or switch this session\'s model',
      input: { hint: '[[provider/]model]' },
      handler: ({ rawInput }) => {
        queueModelCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'clear',
      description: 'Clear the transcript view (session history is unchanged)',
      handler: () => { chat.clear(); requestRender(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'reasoning',
      description: 'Toggle reasoning blocks',
      handler: () => { toggleReasoning(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'tools',
      description: 'Expand or collapse all tool cards',
      handler: () => { toggleTools(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'redraw',
      description: 'Invalidate components and redraw the terminal',
      handler: () => { ui.invalidate(); ui.requestRender(true); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'reload',
      description: 'EXPERIMENTAL (dev): re-read loader config files and apply the diff (idle only)',
      handler: () => { runReload(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'resume',
      description: 'List this workspace\'s resumable sessions',
      handler: () => { showResume(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'status',
      description: 'Show session diagnostics, system prompt, and registered tools',
      handler: async ({ signal }) => { await showStatus(signal); return { kind: 'success' } },
    })
    const exitHandler = (): CommandResult => {
      requestExit()
      return { kind: 'success' }
    }
    commandCtx.commands.register({
      name: 'exit',
      description: 'Exit after the active turn reaches idle',
      handler: exitHandler,
    })
    commandCtx.commands.register({
      name: 'quit',
      description: 'Exit after the active turn reaches idle',
      handler: exitHandler,
    })
  })
  const fileReferencePromptFiber = agent.ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'ui:tui-file-reference',
      order: 99,
      // Tool visibility can change dynamically or by agent scope. Empty
      // sections are omitted by renderPrompt, so guidance never names a tool
      // that this agent cannot call.
      text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
    })
  })

  const runCommand = (text: string): void => {
    const controller = new AbortController()
    commandControllers.add(controller)
    void ctx.commands.execute(agent, text, controller.signal).then(
      (result) => {
        if (disposed) return
        if (result === undefined) {
          appendNotice(`Unknown command: ${text}`, 'warning')
        } else if (result.text !== undefined && result.text !== '') {
          appendNotice(result.text, result.kind === 'error' ? 'error' : 'info')
        }
      },
      (error: unknown) => {
        if (!disposed) {
          appendNotice(`Command failed: ${errorChain(error)}`, 'error')
        }
      },
    ).finally(() => { commandControllers.delete(controller) })
  }

  const dispatchMessage = (content: ContentBlock[], contexts: HookContext[]): void => {
    if (agent.status === 'disposed') {
      appendNotice(`Agent "${agent.id}" is disposed.`, 'error')
    } else if (agent.status === 'running') {
      agent.steer(content, { contexts })
    } else {
      agent.followup(content, { contexts })
    }
  }

  /** Deliver a user turn to the agent: steer while running, send while idle, or report a disposed agent. */
  const deliver = (payload: string): void => {
    dispatchMessage([{ type: 'text', text: payload }], [])
  }

  /** Load a manually invoked skill and deliver its rendered body as a user turn, reporting lookup outcomes as notices. */
  const invokeSkill = (name: string, instructions: string): void => {
    if (skills === undefined) {
      appendNotice('Skills are not available in this session.', 'warning')
      return
    }
    skills.get(name, { cwd, signal: skillAbort.signal }).then(
      (skill) => {
        if (disposed) return
        if (skill === undefined) {
          appendNotice(`Unknown skill: ${name}`, 'warning')
          return
        }
        deliver(renderSkillInvocation(skill, instructions))
      },
      (error: unknown) => {
        if (disposed) return
        appendNotice(`Skill "${name}" failed to load: ${errorChain(error)}`, 'error')
      },
    )
  }

  // EXPERIMENTAL, dev-only: manually re-read every file-backed loader config
  // tree and apply the diff to the running app — the same path the HMR
  // watcher's config-change branch drives, minus the watcher. Useful when the
  // watcher misses an edit (replace-by-rename saves) or HMR is not mounted.
  // Module-source hot reload stays watcher-owned; this refreshes configs only.
  let reloadInFlight = false
  const runReload = (): void => {
    // Idle-only: a reload can dispose and re-mount entries mid-flight; doing
    // that under an active turn could tear tools or the adapter out from
    // under in-flight calls. Idleness is advisory (a send can race in after
    // the check), but it removes the common footgun.
    if (agent.status !== 'idle') {
      appendNotice(`/reload requires an idle agent (status: ${agent.status}).`, 'warning')
      return
    }
    // Re-entrancy guard: concurrent refreshes over a genuinely changed file
    // would race unmutexed tree updates (create/remove interleaving); one
    // reload at a time keeps the update pass single-writer.
    if (reloadInFlight) {
      appendNotice('A config reload is already running.', 'warning')
      return
    }

    // Optional-service lookup: the TUI must not depend on the Loader (tests
    // and embedders run without one), so `loader` stays out of `inject` and
    // is read through the non-throwing `ctx.get` accessor — a bare `ctx.loader`
    // proxy read would throw `cannot get property without inject` in a fiber.
    const loader = ctx.get('loader') as { entries(): Iterable<{ subtree?: { refresh?(): Promise<void> } }> } | undefined
    if (loader === undefined) {
      appendNotice('/reload needs the cordis Loader; this runtime has none.', 'warning')
      return
    }
    const refreshes: Promise<void>[] = []
    for (const entry of loader.entries()) {
      if (entry.subtree?.refresh !== undefined) refreshes.push(entry.subtree.refresh())
    }
    reloadInFlight = true
    appendNotice(`Reloading ${refreshes.length} config tree(s)… (experimental)`)
    // refresh() never rejects (it warns and keeps the running tree), so the
    // join can only fulfill; the catch arm guards a future contract change.
    void Promise.all(refreshes).then(() => {
      appendNotice('Config reload complete. Unchanged files were skipped; invalid files keep the running tree (see logs).')
    }).catch((error: unknown) => {
      appendNotice(`Config reload failed: ${errorChain(error)}`, 'error')
    }).finally(() => {
      reloadInFlight = false
    })
  }

  /** Build one display candidate without letting a corrupt neighbor abort the selector. */
  const readResumeCandidate = async (
    record: SessionRecord,
    providers: ReadonlySet<string>,
  ): Promise<ResumeCandidate> => {
    try {
      let snapshot: SessionLogSnapshot
      const live = ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        snapshot = {
          session: structuredClone(live.header),
          events: live.events.map(event => structuredClone(event)),
        }
      } else {
        /* v8 ignore next -- caller checks the optional service before mapping records */
        if (sessionQuery === undefined) throw new Error('session query is unavailable')
        snapshot = await sessionQuery.readSession(record.header.id)
      }
      return summarizeResumeCandidate(
        record,
        snapshot,
        agent.session.id,
        agent.session.header.cwd,
        providers,
      )
    } catch (error: unknown) {
      return {
        record,
        title: 'Unreadable session',
        lastActivityAt: record.header.createdAt,
        lastTurn: 'log unavailable',
        disabledReason: `session cannot be loaded: ${errorChain(error)}`,
      }
    }
  }

  /** Re-read every mutable precondition immediately before terminal handoff. */
  const preflightResume = async (sessionId: SessionId): Promise<ResumeCandidate> => {
    /* v8 ignore next -- only showResume can call this closure, after proving the optional service exists */
    if (sessionQuery === undefined) throw new Error('Resume is unavailable: session query is not mounted.')
    const initialStatus = agentStatus()
    if (initialStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${initialStatus}).`)
    const record = (await sessionQuery.listSessions()).find(candidate => candidate.header.id === sessionId)
    if (record === undefined) throw new Error(`Session "${sessionId}" is no longer available.`)
    const candidate = await readResumeCandidate(
      record,
      new Set(ctx.llm.listProviders().map(provider => provider.id)),
    )
    if (candidate.disabledReason !== undefined) throw new Error(candidate.disabledReason)
    const finalStatus = agentStatus()
    if (finalStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${finalStatus}).`)
    return candidate
  }

  const handoffResume = async (candidate: ResumeCandidate, overlay: TuiOverlaySession): Promise<void> => {
    if (resumeInFlight) return
    resumeInFlight = true
    let terminalReleased = false
    try {
      const checked = await preflightResume(candidate.record.header.id)
      const hostHandoff = runtime.handoffResume
      if (hostHandoff === undefined) {
        const template = config.resumeCommand
        const fallback = template?.replaceAll('{session}', checked.record.header.id)
        await overlay.close()
        resumeOverlay = undefined
        appendNotice(fallback === undefined
          ? 'Session is resumable, but this host cannot hand it off in place.'
          : `This host cannot hand off in place. Exit and run: ${fallback}`, 'warning')
        return
      }
      /* v8 ignore next -- shutdown during preflight invalidates an awaited service read or reaches this guard */
      if (disposed) return
      await ctx.sessions.flush(agent.session)
      // Disposal can run while the flush promise is pending; TypeScript does not model that reentry.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (disposed) return
      if (agent.status !== 'idle') throw new Error(`Resume requires an idle agent (status: ${agent.status}).`)
      await overlay.close()
      resumeOverlay = undefined
      await runtime.terminal.drainInput(100, 20)
      // Disposal can run while terminal draining is pending; TypeScript does not model that reentry.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (disposed) return
      ui.stop()
      terminalReleased = true
      await hostHandoff(checked.record.header.id)
      throw new Error('resume host returned without replacing the process')
    } catch (error: unknown) {
      if (!disposed) {
        if (terminalReleased) {
          ui.start()
          ui.setFocus(editor)
          appendNotice(`Resume handoff failed: ${errorChain(error)}`, 'error')
        } else {
          await overlay.close()
          resumeOverlay = undefined
          appendNotice(`Resume failed: ${errorChain(error)}`, 'error')
        }
      }
    } finally {
      resumeInFlight = false
    }
  }

  /** Open the current-workspace searchable session selector. */
  const showResume = (): void => {
    if (agent.status !== 'idle') {
      appendNotice('Resume requires the current turn to finish or be cancelled first.', 'warning')
      return
    }
    if (sessionQuery === undefined) {
      appendNotice('Resume is not available: session query is not mounted.', 'warning')
      return
    }
    const scan = ++resumeScan
    void resumeOverlay?.close()
    void sessionQuery.listSessions().then(async (records) => {
      if (isDisposed() || scan !== resumeScan) return
      const workspace = records.filter(record => record.header.cwd === agent.session.header.cwd)
      const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))
      const candidates = await Promise.all(workspace.map(record => readResumeCandidate(record, providers)))
      candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt
        || a.record.header.id.localeCompare(b.record.header.id))
      if (isDisposed() || scan !== resumeScan) return
      const session = overlayManager.open({
        create: host => new ResumePicker(
          candidates,
          resolved.maxResumeOptions,
          runtime.formatCwd?.(agent.session.header.cwd) ?? formatCwd(agent.session.header.cwd),
          () => host.viewport.rows,
          palette,
          (candidate) => { void handoffResume(candidate, session) },
          () => { void session.close() },
        ),
        options: {
          width: '100%',
          maxHeight: '100%',
          anchor: 'top-left',
          margin: 0,
        },
      })
      resumeOverlay = session
      void session.closed.then(() => {
        /* v8 ignore next -- overlay FIFO closes this session before a replacement can become the tracked resume overlay */
        if (resumeOverlay === session) resumeOverlay = undefined
      })
      requestRender()
    }, (error: unknown) => {
      if (!disposed && scan === resumeScan) appendNotice(`Resume session scan failed: ${errorChain(error)}`, 'error')
    })
  }

  editor.onSubmit = (value: string) => {
    const text = value.trim()
    if (text === '') return
    const restoreSubmittedInput = (): void => {
      if (editor.getText() === '') editor.setText(value)
    }
    // `/skill:<name>` carries a colon, which the command registry's name
    // grammar rejects, so it is intercepted before generic command routing.
    if (text.startsWith(SKILL_COMMAND_PREFIX)) {
      editor.addToHistory(text)
      editor.setText('')
      const { name: skillName, instructions } = parseSkillCommand(text)
      if (skillName === '') appendNotice('Usage: /skill:<name> [instructions]', 'warning')
      else invokeSkill(skillName, instructions)
      return
    }
    if (value.startsWith('/')) {
      editor.addToHistory(text)
      editor.setText('')
      runCommand(value)
      return
    }
    let parsed: ReturnType<typeof parseSessionReferenceText>
    try {
      parsed = parseSessionReferenceText(text)
    } catch (error: unknown) {
      restoreSubmittedInput()
      appendNotice(`Invalid session reference: ${errorChain(error)}`, 'error')
      return
    }
    if (parsed.references.length === 0) {
      editor.addToHistory(text)
      editor.setText('')
      dispatchMessage([{ type: 'text', text: parsed.text }], [])
      return
    }
    const sessionReferences = ctx.get('sessionReferences')
    if (sessionReferences === undefined) {
      restoreSubmittedInput()
      appendNotice('Session reference capability unavailable.', 'error')
      return
    }
    const controller = new AbortController()
    referenceControllers.add(controller)
    editor.disableSubmit = true
    void sessionReferences.prepare(
      agent,
      [{ type: 'text', text: parsed.text }],
      parsed.references,
      controller.signal,
    ).then((prepared) => {
      if (disposed) return
      editor.addToHistory(text)
      if (editor.getText() === value) editor.setText('')
      dispatchMessage(prepared.content, prepared.contexts)
    }, (error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        restoreSubmittedInput()
        appendNotice(`Session reference failed: ${errorChain(error)}`, 'error')
      }
    }).finally(() => {
      referenceControllers.delete(controller)
      editor.disableSubmit = false
      requestRender()
    })
  }

  const removeInputListener = ui.addInputListener((data) => {
    if (overlayManager.hasActiveOverlay()) return undefined
    if (matchesKey(data, Key.ctrl('o'))) {
      toggleTools()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('r'))) {
      toggleReasoning()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('l'))) {
      ui.invalidate()
      ui.requestRender(true)
      return { consume: true }
    }
    if (matchesKey(data, Key.escape) && agent.status === 'running') {
      agent.cancel({ kind: 'user' })
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (agent.status === 'running') {
        agent.cancel({ kind: 'user' })
      } else if (editor.getText() !== '') {
        editor.setText('')
      } else {
        requestExit()
      }
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (agent.status === 'running') appendNotice('Cancel the active turn before exiting.', 'warning')
      else requestExit()
      return { consume: true }
    }
    return undefined
  })

  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'tool/result') fileSearch.invalidate()
    recordEventUsage(tokens, event)
    if (event.type === 'turn/start' && runningStatus !== undefined) runningStatus.turn = event.data.turn
    if (event.type === 'assistant/message' && streaming?.isSettled()) streaming = undefined
    if (event.type === 'steering/message') {
      // A queued steering message reached the model as it drained; drop its
      // entry from the badge. Matching by source keeps a loop-authored
      // continuation reason popping its own enqueued slot rather than a pending
      // user message's slot.
      const drained = pendingSteering.indexOf(JSON.stringify(event.data.source))
      if (drained >= 0) {
        pendingSteering.splice(drained, 1)
        if (runningStatus !== undefined) refreshStatus()
      }
    }
    if ('surfaceOp' in event && typeof event.surfaceOp === 'object') {
      rebuildTranscript(false)
      return
    }
    renderEvent(event, { addHistory: false, renderChunks: true })
    requestRender()
  })
  const disposeQueued = ctx.on('agent/inbox/enqueue', (subject, info) => {
    if (subject !== agent || !info.steering) return
    pendingSteering.push(JSON.stringify(info.source))
    if (runningStatus !== undefined) refreshStatus()
  })
  const disposeStatus = ctx.on('agent/status', (subject, status) => {
    if (subject !== agent) return
    // Leaving 'running' ends the turn's status line; clear any badge so the
    // next running turn starts from zero (and a cancellation, which discards
    // the queue without logging drains, cannot strand a stale count).
    if (status !== 'running') pendingSteering.length = 0
    setStatus(status)
  })
  const disposeError = ctx.on('agent/error', (subject, turn, step, error) => {
    if (subject !== agent) return
    liveErrors.add(`${turn}:${step}`)
    // Full cause chain: wrapper messages like `fetch failed` carry the
    // actionable transport detail on `cause`.
    appendNotice(errorChain(error), 'error')
  })
  const disposeAgent = ctx.on('agent/disposed', (subject) => {
    if (subject !== agent) return
    clearStatus()
    appendNotice(`Agent "${agent.id}" was disposed.`, 'warning')
  })

  const detachListeners = (): void => {
    skillAbort.abort()
    fileSearch.dispose()
    removeInputListener()
    disposeCommandChanges()
    disposePromptChanges()
    for (const value of promptValues) value.dispose()
    stopBannerReveal()
    disposeSessionEvents()
    disposeQueued()
    disposeStatus()
    disposeError()
    disposeAgent()
    disposeSchemeListener()
    disposeTargetListeners()
  }

  // Sweep reveal of the whole banner: the header wipes in left-to-right over
  // ~BANNER_REVEAL_STEPS frames (started after `ui.start()` succeeds).
  // Configured subtitles skip it so deployments (and snapshot fixtures) stay
  // frame-deterministic.
  let revealTimer: ReturnType<typeof setInterval> | undefined
  const stopBannerReveal = (): void => {
    if (revealTimer === undefined) return
    clearInterval(revealTimer)
    revealTimer = undefined
    header.setRevealWidth(undefined)
  }
  const startBannerReveal = (): void => {
    if (config.welcome !== undefined) return
    const total = Math.max(1, runtime.terminal.columns)
    const step = Math.max(1, Math.ceil(total / BANNER_REVEAL_STEPS))
    let shown = 0
    header.setRevealWidth(0)
    revealTimer = setInterval(() => {
      shown += step
      if (shown >= total) {
        stopBannerReveal()
      } else {
        header.setRevealWidth(shown)
      }
      requestRender()
    }, BANNER_REVEAL_INTERVAL_MS)
  }

  rebuildTranscript(true)
  const restoredGoal = foldGoal(agent.session.events).goal
  /* v8 ignore next -- goal replay coverage lives with the goal seam; the TUI only formats its startup notice. */
  if (restoredGoal !== undefined && restoredGoal.phase !== 'complete') {
    appendNotice(
      `Goal restored (${restoredGoal.phase}) with automatic continuation disarmed. `
      + 'Human confirmation is required; send “继续” or run /goal resume.',
      'warning',
    )
  }
  setStatus(agent.status)
  try {
    ui.start()
  } catch (error: unknown) {
    disposed = true
    detachListeners()
    void Promise.all([
      commandFiber.dispose(),
      fileReferencePromptFiber.dispose(),
    ]).catch(
      /* v8 ignore next 2 -- command registration cleanup is non-throwing; this guards a future disposer regression */
      (cleanupError: unknown) => {
        ctx.logger.warn(`ui-tui: scoped cleanup after startup failure failed: ${errorChain(cleanupError)}`)
      },
    )
    clearStatus()
    disposeUserInteraction()
    ui.stop()
    throw error
  }
  tuiServiceFiber = ctx.inject([], (serviceCtx) => {
    new TuiExtensionServiceImpl(serviceCtx, agent, overlayManager)
  })
  startBannerReveal()

  return {
    async dispose(): Promise<void> {
      detachListeners()
      await shutdown(false)
      await Promise.all([
        commandFiber.dispose(),
        fileReferencePromptFiber.dispose(),
      ])
    },
  }
}

/**
 * Open the pi-tui channel once its configured agent exists.
 *
 * @param ctx - Context supplying the agent registry, tools, and event stream.
 * @param config - Target agent and presentation configuration.
 * @param runtime - Terminal and process-exit boundary.
 */
export function mountTui(ctx: Context, config: Config, runtime: TuiRuntime): void {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const matchesConfiguredIdentity = (agent: Agent): boolean =>
    agent.id === sessionId && ctx.agents.roots().includes(agent)
  let settled = false

  const stopWaiting = (): void => {
    disposeCreated()
    disposeFailure()
  }
  const start = (agent: Agent): void => {
    if (settled || !matchesConfiguredIdentity(agent)) return
    settled = true
    stopWaiting()
    ctx.effect(() => {
      const controller = createTuiChat(ctx, config, runtime)
      return () => controller.dispose()
    }, 'ui-tui')
  }
  const fail = (failedSessionId: SessionId, error: unknown): void => {
    if (settled || failedSessionId !== sessionId) return
    settled = true
    stopWaiting()
    runtime.terminal.write(displayText(`ui-tui: session "${sessionId}" failed to start: ${errorChain(error)}\n`))
    runtime.exit(1)
  }

  const disposeCreated = ctx.on('agent/created', start)
  const disposeFailure = ctx.on('agent-loop/config-start-failed', fail)
  const existing = ctx.agents.roots().find(agent => agent.id === sessionId)
  if (existing !== undefined) start(existing)
}

/** Cordis entry point using the process terminal; explicit TUI composition requires a TTY pair. */
/* v8 ignore start -- production process wiring; fake-terminal tests cover mountTui/createTuiChat,
   and the tui-agent PTY smoke covers the real entry */
export function apply(ctx: Context, config: Config): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('ui-tui: both stdin and stdout must be TTYs; use the one-shot @deepseek-ai/dsh-cli-demo app for pipes')
  }
  // Truecolor is a terminal capability, so detect it here at the process
  // boundary from COLORTERM; an explicit theme value still wins.
  const truecolor = config.theme?.truecolor ?? ['truecolor', '24bit'].includes(process.env.COLORTERM ?? '')
  const resumeHost = ctx.get('tuiResumeHost')
  mountTui(ctx, Object.assign({}, config, { theme: Object.assign({}, config.theme, { truecolor }) }), {
    terminal: new ProcessTerminal(),
    exit: code => process.exit(code),
    ...resumeHost === undefined ? {} : { handoffResume: sessionId => resumeHost.handoff(sessionId) },
  })
}
/* v8 ignore stop */
