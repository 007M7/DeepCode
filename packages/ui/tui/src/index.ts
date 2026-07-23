/**
 * Interactive pi-tui front door for DeepSeek Harness agents. It renders the
 * durable session transcript, drives one configured agent, and provides
 * keyboard-driven user-interaction dialogs without owning agent lifecycle.
 * @module @deepseek-ai/dsh-tui
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Input,
  Key,
  Loader,
  Markdown,
  Spacer,
  Text,
  TUI,
  ProcessTerminal,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type EditorTheme,
  type Focusable,
  type MarkdownTheme,
  type SelectListTheme,
  type SlashCommand,
  type Terminal,
  type TerminalColorScheme,
} from '@earendil-works/pi-tui'
import { Service, type Context, type Fiber } from 'cordis'
import z from 'schemastery'
import {
  installAgentLlmTarget,
  type Agent,
  type AgentLlmTarget,
  type AgentLlmTargetRef,
  type AgentStatus,
  type HookContext,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-commands'
import { assertNever, errorChain } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  LlmModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import {
  displayPromptContent,
  SessionId,
  type JsonValue,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type TodoItem,
} from '@deepseek-ai/dsh-session'
import {
  formatSessionReferenceMention,
  parseSessionReferenceText,
  type SessionReferenceService,
} from '@deepseek-ai/dsh-session-reference'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
// Side-effect type import: declaration-merges the optional `sessionPersistence`
// service onto `Context` so `ctx.get('sessionPersistence')` is typed.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SkillDefinition, SkillResourceBase, SkillService } from '@deepseek-ai/dsh-skill'
import type {
  FileDiff,
  TerminalCallView,
  ToolCallView,
  ToolDefinition,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'
import {
  UserInteractionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-interaction'
import {
  TuiExtensionServiceImpl,
  TuiOverlayManager,
} from './overlay-manager.ts'
import type {
  TuiOverlayRequest,
  TuiOverlaySession,
  TuiTheme,
} from './extension.ts'

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
} from './extension.ts'

declare module 'cordis' {
  interface Context {
    /** Terminal-only interaction service, available only while a TUI is mounted. */
    tui: TuiExtensionService
  }
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
import {
  activeAtToken,
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  formatFileMention,
  WorkspaceFileSearch,
} from './file-autocomplete.ts'

export {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
} from './file-autocomplete.ts'

export const name = 'ui-tui'
export const inject = ['agents', 'commands', 'userInteraction', 'tools', 'llm', 'systemPrompt', 'tokenMeter']

/** Model guidance for path-only file references selected through the TUI. */
export const FILE_REFERENCE_PROMPT = 'Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.'

/** Interaction and presentation settings for the pi-tui terminal mode. */
export interface TuiConfig {
  /** Render model reasoning blocks. */
  showReasoning?: boolean
  /** Maximum tool-card body lines retained in its collapsed head/tail preview. */
  maxToolOutputLines?: number
  /** Maximum options visible at once in a user-question panel. */
  maxQuestionOptions?: number
  /** Maximum models visible at once in the model selector. */
  maxModelOptions?: number
  /** User-question panel width in terminal columns, clamped to the terminal. */
  questionDialogWidth?: number
  /** User-question panel maximum height in terminal rows. */
  questionDialogMaxHeight?: number
  /** Model-selector width in terminal columns. */
  modelDialogWidth?: number
  /** Model-selector maximum height in terminal rows. */
  modelDialogMaxHeight?: number
  /** Maximum fuzzy file candidates displayed for one `@` query. */
  fileSearchMaxResults?: number
  /** Maximum paths retained in one `@` workspace index. */
  fileSearchMaxEntries?: number
  /** Directory basenames excluded from `@` traversal and completion. */
  fileSearchExcludedDirectories?: string[]
  /** Show the terminal's hardware cursor at the pi editor's IME marker. */
  showHardwareCursor?: boolean
  /** Apply the built-in ANSI color palette. */
  color?: boolean
  /**
   * Paint the startup banner's product name in the DeepSeek brand gradient
   * using 24-bit truecolor. Requires {@link TuiConfig.color}; falls back to the
   * flat accent color when either is off. Unset auto-detects `COLORTERM` at the
   * process boundary, so most deployments leave it unset.
   */
  truecolor?: boolean
  /** Terminal window title while the UI is mounted; a logged session title prefixes it. */
  title?: string
}

const showReasoningSchema = z.boolean().default(true)
const maxToolOutputLinesSchema = z.number().step(1).min(1).default(6)
const maxQuestionOptionsSchema = z.number().step(1).min(1).default(8)
const maxModelOptionsSchema = z.number().step(1).min(1).default(8)
const questionDialogWidthSchema = z.number().step(1).min(20).default(200)
const questionDialogMaxHeightSchema = z.number().step(1).min(6).default(20)
const modelDialogWidthSchema = z.number().step(1).min(20).default(72)
const modelDialogMaxHeightSchema = z.number().step(1).min(6).default(20)
const fileSearchMaxResultsSchema = z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_RESULTS)
const fileSearchMaxEntriesSchema = z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_ENTRIES)
const fileSearchExcludedDirectoriesSchema = z.array(z.string()).default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES])
const showHardwareCursorSchema = z.boolean().default(false)
const colorSchema = z.boolean().default(true)
// No default: an unset value auto-detects truecolor from COLORTERM in `apply`.
const truecolorSchema = z.boolean()
const titleSchema = z.string().default('DeepSeek Harness')

const tuiConfigSchemaFields = {
  showReasoning: showReasoningSchema,
  maxToolOutputLines: maxToolOutputLinesSchema,
  maxQuestionOptions: maxQuestionOptionsSchema,
  maxModelOptions: maxModelOptionsSchema,
  questionDialogWidth: questionDialogWidthSchema,
  questionDialogMaxHeight: questionDialogMaxHeightSchema,
  modelDialogWidth: modelDialogWidthSchema,
  modelDialogMaxHeight: modelDialogMaxHeightSchema,
  fileSearchMaxResults: fileSearchMaxResultsSchema,
  fileSearchMaxEntries: fileSearchMaxEntriesSchema,
  fileSearchExcludedDirectories: fileSearchExcludedDirectoriesSchema,
  showHardwareCursor: showHardwareCursorSchema,
  color: colorSchema,
  truecolor: truecolorSchema,
  title: titleSchema,
}

/** Schemastery schema for presentation settings embedded by app bundles. */
export const TuiConfigSchema: z<TuiConfig> = z.object(tuiConfigSchemaFields)

/** Serializable plugin configuration. */
export interface Config extends TuiConfig {
  /** Banner subtitle line. When absent, the banner has no subtitle and sweeps in on start. */
  welcome?: string
  /** Exact shared agent/session identity driven by this terminal. Defaults to `main`. */
  sessionId?: string
  /**
   * Shell command template shown for resuming this session: printed on exit and
   * listed by `/resume`, with every `{session}` occurrence replaced by the live
   * session id. Absent disables both surfaces. Deployments set it only when a
   * persistence backend makes the session resumable (e.g.
   * `RESUME_SESSION_ID={session} dsh`).
   */
  resumeCommand?: string
}

export const Config: z<Config> = z.object({
  welcome: z.string(),
  sessionId: z.string().default('main'),
  resumeCommand: z.string(),
  showReasoning: tuiConfigSchemaFields.showReasoning,
  maxToolOutputLines: tuiConfigSchemaFields.maxToolOutputLines,
  maxQuestionOptions: tuiConfigSchemaFields.maxQuestionOptions,
  maxModelOptions: tuiConfigSchemaFields.maxModelOptions,
  questionDialogWidth: tuiConfigSchemaFields.questionDialogWidth,
  questionDialogMaxHeight: tuiConfigSchemaFields.questionDialogMaxHeight,
  modelDialogWidth: tuiConfigSchemaFields.modelDialogWidth,
  modelDialogMaxHeight: tuiConfigSchemaFields.modelDialogMaxHeight,
  fileSearchMaxResults: tuiConfigSchemaFields.fileSearchMaxResults,
  fileSearchMaxEntries: tuiConfigSchemaFields.fileSearchMaxEntries,
  fileSearchExcludedDirectories: tuiConfigSchemaFields.fileSearchExcludedDirectories,
  showHardwareCursor: tuiConfigSchemaFields.showHardwareCursor,
  color: tuiConfigSchemaFields.color,
  truecolor: tuiConfigSchemaFields.truecolor,
  title: tuiConfigSchemaFields.title,
})

/** Fully defaulted TUI presentation settings. */
export interface ResolvedTuiConfig {
  showReasoning: boolean
  maxToolOutputLines: number
  maxQuestionOptions: number
  maxModelOptions: number
  questionDialogWidth: number
  questionDialogMaxHeight: number
  modelDialogWidth: number
  modelDialogMaxHeight: number
  fileSearchMaxResults: number
  fileSearchMaxEntries: number
  fileSearchExcludedDirectories: string[]
  showHardwareCursor: boolean
  color: boolean
  truecolor: boolean
  title: string
}

/** Runtime boundary used by the interactive TUI. */
export interface TuiRuntime {
  /** Terminal implementation; production uses pi-tui's `ProcessTerminal`. */
  terminal: Terminal
  /** Exit hook used by terminal shutdown or a target-agent startup failure. */
  exit(code: number): void
  /**
   * Override the footer's logical working-directory label without changing the session directory used by tools.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped label; the TUI makes terminal controls visible.
   */
  formatCwd?: (cwd: string | undefined) => string
  /** Monotonic-enough wall clock for elapsed status rendering. Defaults to `Date.now`. */
  now?(): number
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided terminal presentation settings.
 * @returns Complete settings consumed by the TUI renderer.
 */
export function resolveTuiConfig(config: TuiConfig | undefined): ResolvedTuiConfig {
  return {
    showReasoning: config?.showReasoning ?? true,
    maxToolOutputLines: config?.maxToolOutputLines ?? 6,
    maxQuestionOptions: config?.maxQuestionOptions ?? 8,
    maxModelOptions: config?.maxModelOptions ?? 8,
    questionDialogWidth: config?.questionDialogWidth ?? 200,
    questionDialogMaxHeight: config?.questionDialogMaxHeight ?? 20,
    modelDialogWidth: config?.modelDialogWidth ?? 72,
    modelDialogMaxHeight: config?.modelDialogMaxHeight ?? 20,
    fileSearchMaxResults: config?.fileSearchMaxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS,
    fileSearchMaxEntries: config?.fileSearchMaxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
    fileSearchExcludedDirectories: [...(config?.fileSearchExcludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES)],
    showHardwareCursor: config?.showHardwareCursor ?? false,
    color: config?.color ?? true,
    truecolor: config?.truecolor ?? false,
    title: config?.title ?? 'DeepSeek Harness',
  }
}

interface Palette {
  accent: (text: string) => string
  accent2: (text: string) => string
  text: (text: string) => string
  muted: (text: string) => string
  dim: (text: string) => string
  success: (text: string) => string
  warning: (text: string) => string
  error: (text: string) => string
  code: (text: string) => string
  added: (text: string) => string
  removed: (text: string) => string
  bold: (text: string) => string
  italic: (text: string) => string
  underline: (text: string) => string
  strike: (text: string) => string
  /** Reverse video for the active selection; swaps the theme's own fg/bg so it reads on any scheme. */
  selected: (text: string) => string
}

function ansi(open: string, close: string, enabled: boolean): (text: string) => string {
  return enabled ? text => `\x1b[${open}m${text}\x1b[${close}m` : text => text
}

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu

/**
 * Escape external C0/C1 controls before pi-tui adds application-owned ANSI.
 * Line feeds remain structural so transcript and tool output retain their layout.
 */
function displayText(text: string): string {
  return text.replace(TERMINAL_CONTROL_PATTERN, control =>
    `\\x${control.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** Escape external controls for terminal fields that must remain on one line. */
function displayInlineText(text: string): string {
  return displayText(text).replaceAll('\n', '\\x0a')
}

/**
 * Theme-agnostic palette built from the standard 16-color ANSI set plus SGR
 * attributes, which every terminal remaps to its active color scheme. Body
 * `text` stays the terminal's default foreground so it reads on light and dark
 * backgrounds alike; grouping uses foreground-only gutter bars and reverse
 * video rather than fixed background fills.
 */
function createPalette(enabled: boolean, scheme: TerminalColorScheme = 'dark'): Palette {
  return {
    accent: ansi('94', '39', enabled),
    accent2: ansi('95', '39', enabled),
    text: text => text,
    muted: ansi('90', '39', enabled),
    // SGR 2 (dim) lightens text on a light background — substitute ANSI 90
    // (bright black / gray) which renders as a readable muted tone on any scheme.
    dim: scheme === 'light' ? ansi('90', '39', enabled) : ansi('2', '22', enabled),
    success: ansi('32', '39', enabled),
    warning: ansi('33', '39', enabled),
    error: ansi('31', '39', enabled),
    // ANSI 36 (cyan) is difficult to read on a light background — use
    // ANSI 34 (blue) which is legible on both light and dark schemes.
    code: scheme === 'light' ? ansi('34', '39', enabled) : ansi('36', '39', enabled),
    added: ansi('32', '39', enabled),
    removed: ansi('31', '39', enabled),
    bold: ansi('1', '22', enabled),
    italic: ansi('3', '23', enabled),
    underline: ansi('4', '24', enabled),
    strike: ansi('9', '29', enabled),
    selected: ansi('7', '27', enabled),
  }
}

/**
 * DeepSeek brand gradient stops (indigo → light blue) taken from the
 * deepseek.com logo, painted across the startup banner's product name on
 * truecolor terminals. Fixed brand identity, deliberately outside the
 * theme-adaptive {@link Palette}.
 */
const BRAND_GRADIENT = [
  [77, 107, 254], // #4D6BFE
  [57, 130, 255], // #3982FF
  [36, 152, 255], // #2498FF
] as const

/**
 * Sample {@link BRAND_GRADIENT} at fraction `t` via piecewise-linear
 * interpolation across its stops.
 *
 * @param t - Position along the gradient; clamped to [0, 1].
 * @returns The interpolated `[r, g, b]` channels, each rounded to 0–255.
 */
function brandColorAt(t: number): readonly [number, number, number] {
  const span = Math.min(Math.max(t, 0), 1) * (BRAND_GRADIENT.length - 1)
  const index = Math.min(Math.floor(span), BRAND_GRADIENT.length - 2)
  const local = span - index
  // `index` is clamped to a valid adjacent pair, so both lookups are in-bounds.
  const from = BRAND_GRADIENT[index] as readonly [number, number, number]
  const to = BRAND_GRADIENT[index + 1] as readonly [number, number, number]
  return [
    Math.round(from[0] + (to[0] - from[0]) * local),
    Math.round(from[1] + (to[1] - from[1]) * local),
    Math.round(from[2] + (to[2] - from[2]) * local),
  ]
}

/**
 * Paint `text` left-to-right in the DeepSeek brand gradient with per-character
 * 24-bit foreground codes, resetting to the default foreground at the end.
 * Foreground-only, so it stays legible on any terminal background; the caller
 * gates it on truecolor support and wraps it in bold.
 *
 * @param text - Text to colorize; sampled once per character.
 * @returns `text` wrapped in truecolor SGR foreground codes.
 */
function gradientText(text: string): string {
  // The sole caller passes the ASCII product name, so UTF-16 unit iteration
  // samples exactly one color per visible letter.
  const last = Math.max(1, text.length - 1)
  let painted = ''
  for (let index = 0; index < text.length; index += 1) {
    const [r, g, b] = brandColorAt(index / last)
    painted += `\x1b[38;2;${r};${g};${b}m${text.charAt(index)}`
  }
  return `${painted}\x1b[39m`
}

function markdownTheme(palette: Palette): MarkdownTheme {
  return {
    heading: text => palette.accent(text),
    link: text => palette.accent(text),
    // pi-tui requires this URL slot but its current Markdown renderer does not invoke it.
    /* v8 ignore next */
    linkUrl: text => palette.dim(text),
    code: text => palette.code(text),
    codeBlock: text => palette.text(text),
    codeBlockBorder: text => palette.dim(text),
    quote: text => palette.muted(text),
    quoteBorder: text => palette.accent2(text),
    hr: text => palette.dim(text),
    listBullet: text => palette.accent(text),
    bold: text => palette.bold(text),
    italic: text => palette.italic(text),
    strikethrough: text => palette.strike(text),
    underline: text => palette.underline(text),
  }
}

function selectTheme(palette: Palette): SelectListTheme {
  return {
    selectedPrefix: palette.accent,
    selectedText: palette.accent,
    description: palette.muted,
    scrollInfo: palette.dim,
    noMatch: palette.warning,
  }
}

function dialogSelectTheme(palette: Palette): SelectListTheme {
  return {
    ...selectTheme(palette),
    selectedText: text => palette.selected(palette.accent(text)),
  }
}

function contentText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`${block.name}(${block.arguments})`)
        break
      case 'tool-result':
        parts.push(contentText(block.content))
        break
      default: {
        const rawType = (block as { type?: unknown }).type
        parts.push(`[${typeof rawType === 'string' ? rawType : 'content'}]`)
        break
      }
    }
  }
  return parts.join('')
}

function textBlocks(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: typeof type }> => block.type === type)
    .map(block => block.text)
    .join('\n\n')
}

interface ModelChoice extends AgentLlmTarget {
  modelName: string
  description?: string
}

function targetLabel(target: AgentLlmTarget): string {
  return `${target.provider}/${target.model}`
}

function initialTarget(agent: Agent): AgentLlmTarget | undefined {
  const logged = agent.session.requestHeader()?.config
  if (logged !== undefined) return { provider: logged.provider, model: logged.model }
  if (agent.options.provider === undefined || agent.options.model === undefined) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

async function readModelChoices(
  ctx: Context,
  current: AgentLlmTarget | undefined,
): Promise<ModelChoice[]> {
  const providers = ctx.llm.listProviders()
  const groups = await Promise.all(providers.map(async (provider) => {
    const advertised = await ctx.llm.listModels(provider.id)
    const models: LlmModelInfo[] = [...advertised]
    if (
      current?.provider === provider.id
      && !models.some(model => model.id === current.model)
    ) {
      models.push({ provider: provider.id, id: current.model, name: current.model })
    }
    return models.map((model): ModelChoice => ({
      provider: provider.id,
      model: model.id,
      modelName: model.name,
      ...model.description === undefined ? {} : { description: model.description },
    }))
  }))
  return groups.flat()
}

/** Milliseconds between banner sweep-reveal frames (~60 fps). */
const BANNER_REVEAL_INTERVAL_MS = 15

/** Number of sweep frames the banner reveal spreads the terminal width over. */
const BANNER_REVEAL_STEPS = 24

/**
 * Borderless startup banner: product title, an optional configured subtitle,
 * and the model/session detail line. No box frame — each line renders as plain
 * left-padded text (matching transcript notices) so it reads on any theme.
 */
class HeaderComponent implements Component {
  /** Columns of the banner currently revealed; `undefined` renders it whole. */
  private revealWidth: number | undefined

  constructor(
    private readonly agent: Agent,
    private readonly subtitle: () => string | undefined,
    private readonly palette: Palette,
    private readonly gradient: boolean,
    private readonly currentModel: () => string | undefined,
  ) {}

  /** Clip the banner to `width` columns (the sweep reveal); `undefined` restores it. */
  setRevealWidth(width: number | undefined): void {
    this.revealWidth = width
  }

  invalidate(): void {}

  render(width: number): string[] {
    const usable = Math.max(1, width - 2)
    const name = this.gradient
      ? this.palette.bold(gradientText('DEEPSEEK'))
      : this.palette.bold(this.palette.accent('DEEPSEEK'))
    const title = `${name} ${this.palette.bold('HARNESS')}`
    const model = displayText(this.currentModel() ?? 'model unset')
    const detail = `${model}  •  ${displayText(this.agent.session.id)}`
    const subtitle = this.subtitle()
    const lines = [
      title,
      ...subtitle === undefined ? [] : [this.palette.muted(displayText(subtitle))],
      this.palette.dim(detail),
    ]
      .flatMap(line => wrapTextWithAnsi(line, usable))
      .map(line => ` ${truncateToWidth(line, usable, '')}`)
    if (this.revealWidth === undefined) return lines
    const revealed = this.revealWidth
    return lines.map(line => truncateToWidth(line, revealed, ''))
  }
}

/** Milliseconds between elapsed-time refreshes of the running status line. */
const STATUS_ELAPSED_INTERVAL_MS = 1000

/** Steering/cancel affordance shown on every running status line. */
const STATUS_HINT = 'Enter sends steering, Esc cancels'

/**
 * Fine-grained activity of a running turn, derived in the TUI from session
 * lifecycle events for the status line. It is presentation-only, not a durable
 * agent state: `waiting` spans a step from its `step/start` until the first
 * reasoning or text chunk, `thinking`/`responding` track reasoning/text deltas,
 * and `executing` covers tool calls until the next step begins.
 */
type TurnPhase = 'waiting' | 'thinking' | 'responding' | 'executing'

/**
 * Live controller for the running status line: its {@link Loader}, the derived
 * {@link TurnPhase}, the elapsed-time baselines the label reads, and the timer
 * that refreshes it. Present only while the turn runs; `undefined` when idle.
 */
interface RunningStatus {
  loader: Loader
  phase: TurnPhase
  phaseStartedAt: number
  stepStartedAt: number
  timer: ReturnType<typeof setInterval>
}

/** Status-line label for each {@link TurnPhase}. */
const TURN_PHASE_LABELS: Record<TurnPhase, string> = {
  waiting: 'Waiting for the first token',
  thinking: 'Thinking',
  responding: 'Responding',
  executing: 'Executing tools',
}

/**
 * Format a non-negative elapsed span as a compact status duration: whole
 * seconds under a minute (`8s`), else minutes and zero-padded seconds
 * (`1m05s`).
 * @param elapsedMs - Elapsed time in milliseconds; negatives clamp to zero.
 * @returns The compact duration string.
 */
function formatStatusDuration(elapsedMs: number): string {
  const total = Math.floor(Math.max(0, elapsedMs) / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${(total % 60).toString().padStart(2, '0')}s`
}

/**
 * Compose the running status-line text from the current phase, its timers, and
 * the queued-steering badge. The waiting phase spans the whole step so it shows
 * one duration; later phases show time in the phase plus the running step
 * total, and a non-zero `queued` count surfaces as a badge before the hint.
 * @param phase - The current turn phase.
 * @param phaseMs - Elapsed time in the current phase, in milliseconds.
 * @param stepMs - Elapsed time in the current step, in milliseconds.
 * @param queued - Count of pending steering messages; zero hides the badge.
 * @returns The status-line text, including the steering/cancel hint.
 */
function formatTurnStatus(phase: TurnPhase, phaseMs: number, stepMs: number, queued: number): string {
  const timing = phase === 'waiting'
    ? formatStatusDuration(stepMs)
    : `${formatStatusDuration(phaseMs)} · total ${formatStatusDuration(stepMs)}`
  const badge = queued > 0 ? `${queued} queued · ` : ''
  return `${TURN_PHASE_LABELS[phase]} ${timing} — ${badge}${STATUS_HINT}`
}

/**
 * Groups children behind a colored left-gutter bar (`▌`). Foreground-only, so
 * it renders legibly on any terminal background — unlike a filled block whose
 * body text would collide with the theme's default foreground.
 */
class GutterBox implements Component {
  protected readonly children: Component[] = []

  constructor(private readonly barFn: (text: string) => string, private readonly paddingY = 1) {}

  addChild(child: Component): void {
    this.children.push(child)
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate()
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2)
    const body: string[] = []
    for (const child of this.children) for (const line of child.render(inner)) body.push(line)
    // Every caller adds a non-empty title/label child, so an all-empty box is unreachable;
    // the guard preserves Box semantics (render nothing) rather than emitting stray gutter bars.
    /* v8 ignore next */
    if (body.length === 0) return []
    const bar = this.barFn('▌')
    const pad = Array.from({ length: this.paddingY }, () => '')
    return [...pad, ...body, ...pad].map(line => `${bar} ${line}`)
  }
}

class UserMessageComponent extends GutterBox {
  constructor(text: string, palette: Palette, mdTheme: MarkdownTheme, label = 'You') {
    super(value => palette.accent(value))
    this.addChild(new Text(palette.bold(palette.accent(displayText(label))), 0, 0))
    this.addChild(new Markdown(displayText(text), 0, 0, mdTheme, { color: value => palette.text(value) }, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
    }))
  }
}

class AssistantMessageComponent extends Container {
  constructor(content: readonly ContentBlock[], showReasoning: boolean, palette: Palette, mdTheme: MarkdownTheme) {
    super()
    const reasoning = displayText(textBlocks(content, 'reasoning').trim())
    const text = displayText(textBlocks(content, 'text').trim())
    if (reasoning && showReasoning) {
      this.addChild(new Spacer(1))
      this.addChild(new Text(palette.italic(palette.muted('Reasoning')), 1, 0))
      this.addChild(new Markdown(reasoning, 1, 0, mdTheme, {
        color: value => palette.muted(value),
        italic: true,
      }))
    }
    if (text) {
      this.addChild(new Spacer(1))
      this.addChild(new Text(palette.bold(palette.accent2('Assistant')), 1, 0))
      this.addChild(new Markdown(text, 1, 0, mdTheme, { color: value => palette.text(value) }))
    }
  }
}

interface StreamingBlock {
  type: string
  text: string
}

class StreamingAssistantComponent extends Container {
  private readonly blocks = new Map<number, StreamingBlock>()

  constructor(
    private showReasoning: boolean,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
  ) {
    super()
  }

  update(chunk: StreamChunk): void {
    if (chunk.type === 'block-start') {
      this.blocks.set(chunk.index, { type: chunk.blockType, text: '' })
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      const block = this.blocks.get(chunk.index) ?? { type, text: '' }
      block.text += chunk.text
      this.blocks.set(chunk.index, block)
    } else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
      this.blocks.set(chunk.index, { type: chunk.block.type, text: chunk.block.text })
    }
    this.rebuild()
  }

  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    this.rebuild()
  }

  private rebuild(): void {
    this.clear()
    const content: ContentBlock[] = [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap<ContentBlock>(([, block]) => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type === 'reasoning') return [{ type: 'reasoning', text: block.text }]
        return []
      })
    const component = new AssistantMessageComponent(content, this.showReasoning, this.palette, this.mdTheme)
    for (const child of component.children) this.addChild(child)
  }
}

interface ParsedArguments {
  value: unknown
  valid: boolean
}

function parseArguments(raw: string): ParsedArguments {
  try {
    return { value: JSON.parse(raw), valid: true }
  } catch {
    return { value: raw, valid: false }
  }
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return displayText(value)
  // The lib declaration narrows `unknown` to a string-returning overload, but
  // JSON.stringify returns undefined for runtime values such as symbols.
  const serialized = JSON.stringify(value, null, 2) as string | undefined
  return displayText(serialized ?? String(value))
}

function diffLines(diff: FileDiff, palette: Palette): string[] {
  const lines = [palette.bold(displayText(diff.path))]
  if (diff.oldText !== null) {
    for (const line of displayText(diff.oldText).split('\n')) lines.push(palette.removed(`- ${line}`))
  }
  for (const line of displayText(diff.newText).split('\n')) lines.push(palette.added(`+ ${line}`))
  return lines
}

class ToolCardComponent implements Component {
  private result: { content: ContentBlock[]; isError: boolean; meta?: JsonValue } | undefined
  private expanded = false
  private callView: ToolCallView
  private resultView: ToolResultView | undefined

  constructor(
    private readonly name: string,
    private readonly parsed: ParsedArguments,
    private readonly definition: ToolDefinition | undefined,
    private readonly maxOutputLines: number,
    private readonly palette: Palette,
  ) {
    this.callView = this.presentCall()
  }

  private presentCall(): ToolCallView {
    if (this.parsed.valid && this.definition?.presentCall) {
      try {
        const view = this.definition.presentCall(this.parsed.value)
        if (view !== undefined) return view
      } catch (error: unknown) {
        return { card: 'generic', title: displayText(this.name), rawInput: `Presenter failed: ${String(error)}` }
      }
    }
    return { card: 'generic', title: displayText(this.name), rawInput: this.parsed.value }
  }

  updateResult(event: Extract<SessionEvent, { type: 'tool/result' }>['data']): void {
    this.result = {
      content: [...event.content],
      isError: event.isError,
      ...event.meta !== undefined ? { meta: event.meta } : {},
    }
    if (this.parsed.valid && this.definition?.presentResult) {
      try {
        const view = this.definition.presentResult(this.parsed.value, this.result)
        if (view !== undefined) this.resultView = view
      } catch (error: unknown) {
        this.resultView = { card: 'generic', content: [{ type: 'text', text: `Presenter failed: ${String(error)}` }] }
      }
    }
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  invalidate(): void {}

  render(width: number): string[] {
    const isError = this.result?.isError ?? false
    const glyph = this.result === undefined ? this.palette.warning('◌') : isError ? this.palette.error('✕') : this.palette.success('✓')
    const body = this.renderBody()
    const title = truncateToWidth(`${glyph} ${displayText(this.title())}`, Math.max(1, width - 4), '')
    const headLines = Math.ceil(this.maxOutputLines / 2)
    const tailLines = this.maxOutputLines - headLines
    const visibleBody = this.expanded || body.length <= this.maxOutputLines
      ? body
      : [
        ...body.slice(0, headLines),
        this.palette.dim(`… +${body.length - this.maxOutputLines} lines (Ctrl+O to expand)`),
        ...body.slice(body.length - tailLines),
      ]
    const barFn = this.result === undefined
      ? this.palette.warning
      : isError ? this.palette.error : this.palette.success
    const box = new GutterBox(barFn, visibleBody.length > 0 ? 1 : 0)
    box.addChild(new Text(this.palette.bold(title), 0, 0))
    if (visibleBody.length > 0) box.addChild(new Text(visibleBody.join('\n'), 0, 0))
    return box.render(width)
  }

  private title(): string {
    return this.resultView?.title ?? this.callView.title
  }

  private renderBody(): string[] {
    const view = this.resultView ?? this.callView
    if (view.card === 'terminal') {
      const pending = this.callView.card === 'terminal' ? this.callView : undefined
      const lines: string[] = []
      if (pending?.description) lines.push(this.palette.muted(displayText(pending.description)))
      if (pending?.cwd) lines.push(this.palette.dim(displayText(pending.cwd)))
      if (this.resultView?.card === 'terminal') {
        if (this.resultView.output) lines.push(...displayText(this.resultView.output).split('\n'))
        if (this.resultView.exitCode !== undefined) lines.push(this.palette.dim(`[exit ${this.resultView.exitCode}]`))
        if (this.resultView.signal !== undefined) {
          lines.push(this.palette.error(`[signal ${displayText(this.resultView.signal)}]`))
        }
      } else if (this.result === undefined) {
        // A pending terminal view is the call view itself; TerminalCallView requires a title.
        lines.push(this.palette.code(`$ ${displayText((pending as TerminalCallView).title)}`))
      } else {
        lines.push(...displayText(contentText(this.result.content)).split('\n'))
      }
      return lines.filter(Boolean)
    }
    if (view.card === 'diff') {
      return view.diffs.flatMap((diff, index) => [
        ...index > 0 ? [''] : [],
        ...diffLines(diff, this.palette),
      ])
    }
    const content = view.content ?? this.result?.content
    const lines: string[] = []
    if (content !== undefined) lines.push(...displayText(contentText(content)).split('\n'))
    const rawInput = this.result === undefined && this.callView.card === 'generic'
      ? this.callView.rawInput
      : undefined
    if (rawInput !== undefined) lines.push(...pretty(rawInput).split('\n'))
    return lines.filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1))
  }
}

class TodoComponent implements Component {
  private todos: readonly TodoItem[] = []

  constructor(private readonly palette: Palette) {}

  update(todos: readonly TodoItem[]): void {
    this.todos = todos
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.todos.length === 0) return []
    const lines = [this.palette.bold(this.palette.accent('Plan'))]
    for (const todo of this.todos) {
      const prefix = todo.status === 'completed'
        ? this.palette.success('✓')
        : todo.status === 'in_progress'
          ? this.palette.warning('●')
          : this.palette.dim('○')
      const content = displayText(todo.content)
      const text = todo.status === 'completed' ? this.palette.muted(content) : content
      lines.push(truncateToWidth(`  ${prefix} ${text}`, width, ''))
    }
    return ['', ...lines]
  }
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
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

/**
 * Running token totals for the footer, keyed per turn/step so replayed or
 * re-emitted usage replaces rather than double-counts; `input` is uncached
 * input, cache buckets are disjoint.
 */
interface SessionTokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  readonly byStep: Map<string, TokenUsage>
}

function recordTokenUsage(totals: SessionTokenTotals, turn: number, step: number, usage: TokenUsage): void {
  const key = `${turn}:${step}`
  const previous = totals.byStep.get(key)
  if (previous !== undefined) {
    totals.input -= previous.inputTokens
    totals.output -= previous.outputTokens
    totals.cacheRead -= previous.cacheReadTokens ?? 0
    totals.cacheWrite -= previous.cacheWriteTokens ?? 0
  }
  totals.byStep.set(key, usage)
  totals.input += usage.inputTokens
  totals.output += usage.outputTokens
  totals.cacheRead += usage.cacheReadTokens ?? 0
  totals.cacheWrite += usage.cacheWriteTokens ?? 0
}

function recordEventUsage(totals: SessionTokenTotals, event: SessionEvent): void {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    recordTokenUsage(totals, event.data.turn, event.data.step, event.data.chunk.usage)
  } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    recordTokenUsage(totals, event.data.turn, event.data.step, event.data.usage)
  }
}

/**
 * Share of billed input (prompt) tokens served from the provider cache, as an
 * integer percent, or `undefined` before any input is billed (avoids 0/0 and a
 * meaningless rate on an empty session).
 */
function cacheHitRate(totals: SessionTokenTotals): number | undefined {
  const billedInput = totals.input + totals.cacheRead + totals.cacheWrite
  if (billedInput === 0) return undefined
  return Math.round((totals.cacheRead / billedInput) * 100)
}

function sessionTokens(session: Session): SessionTokenTotals {
  const totals: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byStep: new Map() }
  for (const event of session.events) {
    recordEventUsage(totals, event)
  }
  return totals
}

function formatDiagnosticNumber(value: number): string {
  return value.toLocaleString('en-US')
}

function formatDiagnosticTime(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, ' UTC')
}

function formatDiagnosticCount(value: number, singular: string): string {
  return `${String(value)} ${singular}${value === 1 ? '' : 's'}`
}

function diagnosticMeter(percent: number, palette: Palette): string {
  const width = 16
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 100 * width)
  return `${palette.dim('[')}${palette.accent('█'.repeat(filled))}${palette.dim(`${'░'.repeat(width - filled)}]`)}`
}

type StatusCardRow = readonly [label: string, value: string]

/** Bordered, grouped field card for one point-in-time status snapshot. */
class StatusCardComponent implements Component {
  constructor(
    private readonly groups: readonly (readonly StatusCardRow[])[],
    private readonly palette: Palette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const labels = this.groups.flatMap(group => group.map(([label]) => `${label}:`))
    const naturalLabelWidth = Math.max(...labels.map(label => label.length))
    const naturalBodyWidth = Math.max(...this.groups.flatMap(group => group.map(([, value]) =>
      1 + naturalLabelWidth + 2 + visibleWidth(value))))
    const cardWidth = Math.min(
      Math.max(8, width),
      Math.max('Session status'.length + 5, naturalBodyWidth + 4),
    )
    const innerWidth = Math.max(1, cardWidth - 4)
    const labelWidth = Math.min(
      naturalLabelWidth,
      Math.max(1, Math.floor(innerWidth / 3)),
    )
    const body: string[] = []
    for (const [groupIndex, group] of this.groups.entries()) {
      if (groupIndex > 0) body.push('')
      for (const [label, value] of group) {
        const plainLabel = truncateToWidth(`${label}:`, labelWidth, '')
        const prefix = ` ${this.palette.muted(plainLabel.padEnd(labelWidth))}  `
        const continuation = ' '.repeat(1 + labelWidth + 2)
        const valueWidth = Math.max(1, innerWidth - visibleWidth(prefix))
        const wrapped = wrapTextWithAnsi(value, valueWidth)
        for (const [lineIndex, line] of wrapped.entries()) {
          body.push(`${lineIndex === 0 ? prefix : continuation}${line}`)
        }
      }
    }

    const title = truncateToWidth('Session status', Math.max(1, cardWidth - 5), '')
    const topTail = '─'.repeat(Math.max(0, cardWidth - visibleWidth(title) - 5))
    const top = `${this.palette.dim('╭─ ')}${this.palette.bold(this.palette.accent(title))}${this.palette.dim(` ${topTail}╮`)}`
    const lines = [top]
    for (const line of body) {
      const clipped = truncateToWidth(line, innerWidth, '')
      lines.push(`${this.palette.dim('│')} ${clipped}${' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${this.palette.dim('│')}`)
    }
    lines.push(this.palette.dim(`╰${'─'.repeat(Math.max(0, cardWidth - 2))}╯`))
    return lines
  }
}

class FooterComponent implements Component {
  constructor(
    private readonly agent: Agent,
    private readonly palette: Palette,
    private readonly toolsExpanded: () => boolean,
    private readonly tokens: () => SessionTokenTotals,
    private readonly cwdFormatter: TuiRuntime['formatCwd'],
    private readonly currentModel: () => string | undefined,
    private readonly contextPercent: () => number | undefined,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const totals = this.tokens()
    const model = displayText(this.currentModel() ?? 'model unset')
    const rate = cacheHitRate(totals)
    const cache = rate === undefined ? '' : `  cache ${rate}%`
    const formattedCwd = displayText(
      this.cwdFormatter?.(this.agent.session.header.cwd) ?? formatCwd(this.agent.session.header.cwd),
    )
    const left = `${model}  ${formattedCwd}  ↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}${cache}`
    const contextPercent = this.contextPercent()
    const context = contextPercent === undefined ? '' : `${contextPercent}% context  `
    const right = `${context}tools:${this.toolsExpanded() ? 'expanded' : 'collapsed'}`
    const leftStyled = this.palette.dim(left)
    const available = Math.max(0, width - visibleWidth(left) - 2)
    const rightClipped = truncateToWidth(right, available, '')
    const gap = ' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(rightClipped)))
    return [truncateToWidth(`${leftStyled}${gap}${this.palette.dim(rightClipped)}`, width, '')]
  }
}

interface QuestionSelection {
  selected: string[]
  custom?: string
}

function renderDialog(
  title: string,
  body: readonly string[],
  width: number,
  palette: Palette,
): string[] {
  const innerWidth = Math.max(1, width - 4)
  const topLabel = ` ${displayText(title)} `
  const top = `╭${topLabel}${'─'.repeat(Math.max(0, width - visibleWidth(topLabel) - 2))}╮`
  const lines: string[] = [palette.accent(top)]
  for (const line of body) {
    const clipped = truncateToWidth(line, innerWidth, '')
    lines.push(`${palette.accent('│')} ${clipped}${' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${palette.accent('│')}`)
  }
  lines.push(palette.accent(`╰${'─'.repeat(Math.max(0, width - 2))}╯`))
  return lines
}

class ModelDialog implements Component {
  private readonly list: SelectList

  constructor(
    choices: readonly ModelChoice[],
    current: AgentLlmTarget | undefined,
    maxVisible: number,
    private readonly palette: Palette,
    done: (choice: ModelChoice) => void,
    cancel: () => void,
  ) {
    this.list = new SelectList(choices.map(choice => ({
      value: targetLabel(choice),
      label: displayText(targetLabel(choice)),
      description: [
        displayText(choice.modelName),
        ...choice.description === undefined ? [] : [displayText(choice.description)],
        ...current?.provider === choice.provider && current.model === choice.model ? ['current'] : [],
      ].join(' — '),
    })), maxVisible, dialogSelectTheme(palette))
    const currentIndex = current === undefined
      ? 0
      : choices.findIndex(choice => choice.provider === current.provider && choice.model === current.model)
    this.list.setSelectedIndex(currentIndex)
    this.list.onSelect = (item) => {
      const selected = choices.find(choice => targetLabel(choice) === item.value)
      /* v8 ignore next -- SelectList only returns values built from `choices`. */
      if (selected === undefined) return
      done(selected)
    }
    this.list.onCancel = cancel
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
    this.invalidate()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    return renderDialog('Select model', [
      ...this.list.render(innerWidth),
      '',
      this.palette.dim('↑/↓ navigate • Enter select • Esc cancel'),
    ], width, this.palette)
  }
}

class QuestionDialog implements Component, Focusable {
  private selectedIndex = 0
  private selected = new Set<number>()
  private mode: 'options' | 'custom'
  private error = ''
  private readonly input = new Input()
  private readonly options: NonNullable<AskUserQuestionItem['options']>
  focused = false

  constructor(
    private readonly question: AskUserQuestionItem,
    private readonly position: number,
    private readonly total: number,
    private readonly unanswered: number,
    private readonly maxVisible: number,
    private readonly palette: Palette,
    private readonly done: (selection: QuestionSelection) => void,
    private readonly cancel: () => void,
  ) {
    this.options = question.options ?? []
    this.mode = this.options.length > 0 ? 'options' : 'custom'
    this.input.onSubmit = (value) => { this.submitCustom(value) }
    this.input.onEscape = () => {
      if (this.options.length > 0) {
        this.mode = 'options'
        this.error = ''
      } else {
        this.cancel()
      }
    }
  }

  invalidate(): void {
    this.input.invalidate()
  }

  handleInput(data: string): void {
    this.invalidate()
    if (this.mode === 'custom') {
      this.input.focused = this.focused
      this.input.handleInput(data)
      return
    }
    const options = this.options
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.selectedIndex === 0 ? options.length - 1 : this.selectedIndex - 1
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = this.selectedIndex === options.length - 1 ? 0 : this.selectedIndex + 1
    } else if (matchesKey(data, Key.space) && this.question.multiSelect) {
      if (this.selected.has(this.selectedIndex)) this.selected.delete(this.selectedIndex)
      else this.selected.add(this.selectedIndex)
    } else if (matchesKey(data, Key.enter)) {
      const indices = this.question.multiSelect ? [...this.selected].sort((a, b) => a - b) : [this.selectedIndex]
      if (indices.length === 0) {
        this.error = 'Select at least one option, or press Tab for a custom answer.'
        return
      }
      this.done({ selected: indices.map(index => options[index]?.label).filter((label): label is string => label !== undefined) })
    } else if (matchesKey(data, Key.tab) || data.toLowerCase() === 'c') {
      this.mode = 'custom'
      this.error = ''
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
    }
  }

  private submitCustom(value: string): void {
    const custom = value.trim()
    if (custom === '') {
      this.error = 'Enter an answer before submitting.'
      return
    }
    this.done({ selected: [], custom })
  }

  render(width: number): string[] {
    this.input.focused = this.focused
    const innerWidth = Math.max(1, width - 4)
    const header = `Question ${this.position}/${this.total} (${this.unanswered} unanswered)${this.question.header === undefined ? '' : ` · ${displayText(this.question.header)}`}`
    const lines = [
      this.palette.muted(header),
      ...wrapTextWithAnsi(this.palette.text(displayText(this.question.question)), innerWidth),
    ]
    const push = (line: string): void => { lines.push(line) }
    // Supporting detail (e.g. the full plan under review) renders between the
    // question and the answer surface, kept out of option labels.
    if (this.question.detail !== undefined) {
      push('')
      for (const line of wrapTextWithAnsi(displayText(this.question.detail), innerWidth)) push(line)
    }
    push('')
    if (this.mode === 'custom') {
      for (const line of this.input.render(innerWidth)) push(line)
      push(this.palette.dim(this.options.length > 0 ? 'Enter submit • Esc options' : 'Enter submit • Esc cancel'))
    } else {
      const options = this.options
      const start = Math.max(0, Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        options.length - this.maxVisible,
      ))
      const end = Math.min(options.length, start + this.maxVisible)
      const optionRows = options.slice(start, end).map((option, offset) => {
        const index = start + offset
        const mark = this.question.multiSelect
          ? this.selected.has(index) ? '[x] ' : '[ ] '
          : ''
        return `${index === this.selectedIndex ? '›' : ' '} ${index + 1}. ${mark}${displayText(option.label)}`
      })
      const descriptionColumn = Math.min(
        Math.max(...optionRows.map(row => visibleWidth(row))) + 2,
        Math.max(1, Math.floor(innerWidth * 0.55)),
      )
      for (let index = start; index < end; index += 1) {
        // `index < end <= options.length`; the options array is borrowed immutably for this dialog.
        const option = options[index] as NonNullable<AskUserQuestionItem['options']>[number]
        const mark = this.question.multiSelect
          ? this.selected.has(index) ? '[x] ' : '[ ] '
          : ''
        const left = `${index === this.selectedIndex ? '›' : ' '} ${index + 1}. ${mark}${displayText(option.label)}`
        const leftStyled = index === this.selectedIndex
          ? this.palette.bold(this.palette.accent(left))
          : left
        const description = option.description === undefined
          ? ''
          : `${' '.repeat(Math.max(1, descriptionColumn - visibleWidth(left)))}${this.palette.muted(displayText(option.description))}`
        push(`${leftStyled}${description}`)
      }
      if (options.length > this.maxVisible) push(this.palette.dim(`${this.selectedIndex + 1}/${options.length}`))
      const hint = this.palette.dim(this.question.multiSelect
        ? 'Tab custom answer • ↑/↓ navigate • Space toggle • Enter submit • Esc interrupt'
        : 'Tab custom answer • ↑/↓ navigate • Enter submit • Esc interrupt')
      for (const line of wrapTextWithAnsi(hint, innerWidth)) push(line)
    }
    if (this.error) {
      for (const line of wrapTextWithAnsi(this.palette.error(this.error), innerWidth)) push(line)
    }
    return ['', ...lines, ''].map((line) => {
      const clipped = truncateToWidth(line, innerWidth, '')
      return `  ${clipped}${' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}  `
    })
  }
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

/** Merge path-only file candidates and optional session snapshots with commands. */
class ReferenceAutocompleteProvider implements AutocompleteProvider {
  constructor(
    private readonly base: CombinedAutocompleteProvider,
    private readonly files: WorkspaceFileSearch,
    private readonly sessions: SessionReferenceService | undefined,
    private readonly agent: Agent,
  ) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const basePromise = this.base.getSuggestions(lines, cursorLine, cursorCol, options)
    const currentLine = lines[cursorLine]
    /* v8 ignore next -- Editor always supplies its current state line. */
    if (currentLine === undefined) return basePromise
    const token = activeAtToken(currentLine, cursorCol)
    if (token === undefined) {
      this.files.invalidate()
      return basePromise
    }
    const filePromise = this.files.list(token.query, options.signal).catch(() => [])
    const sessionPromise = this.sessions === undefined || token.quoted
      ? Promise.resolve([])
      : this.sessions.listCandidates(this.agent, token.query, undefined, options.signal).catch(() => [])
    const [base, fileCandidates, sessionCandidates] = await Promise.all([
      basePromise,
      filePromise,
      sessionPromise,
    ])
    if (options.signal.aborted) return base
    const fileItems: AutocompleteItem[] = fileCandidates.flatMap((candidate) => {
      const value = formatFileMention(candidate, token.quoted)
      if (value === undefined) return []
      const name = candidate.path.slice(candidate.path.lastIndexOf('/') + 1)
      const directory = candidate.kind === 'directory'
      return [{
        value,
        label: `${directory ? 'Folder' : 'File'} · ${displayInlineText(name)}${directory ? '/' : ''}`,
        description: displayInlineText(candidate.path),
      }]
    })
    const sessionItems: AutocompleteItem[] = sessionCandidates.map((candidate) => {
      const mentionLabel = displayInlineText(candidate.label)
      const sessionId = displayInlineText(candidate.sessionId)
      const location = candidate.cwd === undefined ? '(no cwd)' : displayInlineText(candidate.cwd)
      const description = `${candidate.label === candidate.sessionId ? '' : `${sessionId} · `}${location} · ${new Date(candidate.createdAt).toISOString()}`
      return {
        value: formatSessionReferenceMention({ sessionId: candidate.sessionId, label: mentionLabel }),
        label: `Session · ${mentionLabel}`,
        description,
      }
    })
    const items = [...fileItems, ...sessionItems]
    if (items.length === 0) return base
    return { items: [...items, ...(base?.items ?? [])], prefix: token.prefix }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.base.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
  }
}

/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
  /** Stop rendering, restore the terminal, and reject pending questions. */
  dispose(): Promise<void>
}

/** Prefix that marks an editor submission as a manual skill invocation. */
const SKILL_COMMAND_PREFIX = '/skill:'

/** Parsed `/skill:<name> [instructions]` submission; `name` is empty when the prefix carries no name. */
interface ParsedSkillCommand {
  /** Skill name typed after `/skill:`, up to the first space. */
  name: string
  /** Trimmed text after the name; empty when none was typed. */
  instructions: string
}

/**
 * Split a `/skill:<name> [instructions]` submission into its name and trailing instructions.
 * @param text - trimmed submission that starts with {@link SKILL_COMMAND_PREFIX}.
 * @returns the skill name and any trailing instructions.
 */
function parseSkillCommand(text: string): ParsedSkillCommand {
  const rest = text.slice(SKILL_COMMAND_PREFIX.length)
  const spaceIndex = rest.indexOf(' ')
  if (spaceIndex === -1) return { name: rest, instructions: '' }
  return { name: rest.slice(0, spaceIndex), instructions: rest.slice(spaceIndex + 1).trim() }
}

/** Model-visible line locating a manually invoked skill's relative resources, or `undefined` when the provider has no base. */
function skillResourceReference(base: SkillResourceBase | undefined): string | undefined {
  if (base === undefined) return undefined
  switch (base.kind) {
    case 'directory':
      return `References in this skill are relative to ${base.path}.`
    case 'url':
      return `References in this skill are relative to ${base.url}.`
    case 'opaque':
      return base.description
    default:
      return assertNever(base, 'SkillResourceBase.kind')
  }
}

/**
 * Render a manually invoked skill into the model-visible user-message text. The
 * `<skill>` block carries the body and, when the provider supplies one, its
 * resource base; the trimmed `instructions` follow the block as the user's
 * request for this turn. The name is registry-validated kebab-case
 * ({@link SkillService} rejects any other) and the resource base is trusted
 * same-process provider prose, so — unlike the model-facing `dsh-tool-skill`
 * result, which escapes for a tool channel — this user turn is assembled raw.
 * @param skill - the loaded skill definition.
 * @param instructions - trimmed text typed after `/skill:<name>`; empty when absent.
 * @returns the user-message text delivered to the agent.
 */
export function renderSkillInvocation(skill: SkillDefinition, instructions: string): string {
  const lines = [`<skill name="${skill.name}">`]
  const reference = skillResourceReference(skill.resourceBase)
  if (reference !== undefined) lines.push(reference, '')
  lines.push(skill.content, '</skill>')
  const block = lines.join('\n')
  return instructions === '' ? block : `${block}\n\n${instructions}`
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
  const resolved = resolveTuiConfig(config)
  const palette = createPalette(resolved.color)
  const mdTheme = markdownTheme(palette)
  const ui = new TUI(runtime.terminal, resolved.showHardwareCursor)
  const chat = new Container()
  const todoContainer = new Container()
  const statusContainer = new Container()
  const editor = new Editor(ui, {
    borderColor: palette.dim,
    selectList: selectTheme(palette),
  } satisfies EditorTheme, { paddingX: 1 })
  const todo = new TodoComponent(palette)
  let showReasoning = resolved.showReasoning
  let toolsExpanded = false
  let streaming: StreamingAssistantComponent | undefined
  let runningStatus: RunningStatus | undefined
  // Steering messages queued during the running turn (`agent/queued`) that the
  // loop has not yet drained, shown as a badge on the status line. Each entry is
  // the queued message's serialized source: a drain (`steering/message`) removes
  // one MATCHING entry, so loop-authored steering — continuation reasons enter
  // the inbox without an `agent/queued` event — cannot consume a pending user
  // message's slot. Cleared on leaving `running`, which also absorbs a
  // cancellation that discards the queue without logging drains; the status
  // line exists only while running, so idle carries no badge to keep current.
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
  let tuiServiceFiber: Fiber | undefined
  const target: AgentLlmTargetRef = { current: initialTarget(agent), assembled: undefined }
  let contextWindow: number | undefined
  let contextResolution: Promise<
    | { readonly kind: 'resolved'; readonly contextWindow: number | undefined }
    | { readonly kind: 'error'; readonly error: unknown }
  > | undefined
  let modelCommands = Promise.resolve()
  const now = (): number => runtime.now?.() ?? Date.now()

  // A configured subtitle renders as a banner line; when absent, the banner has
  // no subtitle. The banner itself sweeps in on start (see startBannerReveal).
  let sessionTitle = foldSessionTitle(agent.session.events)?.title
  const header = new HeaderComponent(
    agent,
    () => sessionTitle ?? config.welcome,
    palette,
    resolved.color && resolved.truecolor,
    () => target.current?.model,
  )
  const footer = new FooterComponent(
    agent,
    palette,
    () => toolsExpanded,
    () => tokens,
    runtime.formatCwd,
    () => target.current?.model,
    () => contextWindow === undefined
      ? undefined
      : Math.min(100, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens / contextWindow * 100)),
  )
  ui.addChild(header)
  ui.addChild(chat)
  ui.addChild(statusContainer)
  todoContainer.addChild(todo)
  ui.addChild(todoContainer)
  ui.addChild(editor)
  ui.addChild(footer)
  ui.setFocus(editor)
  const updateTerminalTitle = (): void => {
    runtime.terminal.setTitle(displayText(
      sessionTitle === undefined ? resolved.title : `${sessionTitle} — ${resolved.title}`,
    ))
  }
  updateTerminalTitle()

  const requestRender = (): void => {
    footer.invalidate()
    ui.requestRender()
  }

  const appendNotice = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
    const color = kind === 'error' ? palette.error : kind === 'warning' ? palette.warning : palette.muted
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(color(displayText(message)), 1, 0))
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
      : ctx.llm.resolveModelContext(selected.provider, selected.model).then(
        context => ({ kind: 'resolved', contextWindow: context?.contextWindow } as const),
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

  const selectModel = (selected: ModelChoice): void => {
    if (target.current?.provider === selected.provider && target.current.model === selected.model) {
      appendNotice(`Model is already ${targetLabel(selected)}.`)
      return
    }
    target.current = { provider: selected.provider, model: selected.model }
    resolveContextWindow(target.current)
    appendNotice(`Model selected: ${targetLabel(selected)}. New steps will use it.`)
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
        (selected) => {
          void session.close()
          selectModel(selected)
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

  const clearStatus = (): void => {
    if (runningStatus !== undefined) {
      clearInterval(runningStatus.timer)
      runningStatus.loader.stop()
      runningStatus = undefined
    }
    statusContainer.clear()
    runtime.terminal.setProgress(false)
  }

  // Refresh the status line's elapsed timers and queued badge from the
  // controller's phase and the current steering count.
  const renderStatus = (running: RunningStatus): void => {
    const at = now()
    running.loader.setMessage(
      formatTurnStatus(running.phase, at - running.phaseStartedAt, at - running.stepStartedAt, pendingSteering.length),
    )
  }

  // Move to a derived phase, resetting the phase timer on a genuine change and
  // the step timer when a new step begins; ignored unless a turn is running.
  const enterPhase = (phase: TurnPhase, resetStep: boolean): void => {
    const running = runningStatus
    if (running === undefined) return
    const at = now()
    if (resetStep) running.stepStartedAt = at
    if (phase !== running.phase || resetStep) running.phaseStartedAt = at
    running.phase = phase
    renderStatus(running)
  }

  const setStatus = (status: AgentStatus): void => {
    // A running→running rebuild (a mid-turn palette swap re-derives the border)
    // carries the derived phase and both elapsed baselines across; only a fresh
    // idle→running turn starts at `waiting`.
    const prior = runningStatus
    clearStatus()
    editor.borderColor = status === 'running' ? text => palette.accent(text) : text => palette.dim(text)
    if (status === 'running') {
      const at = now()
      const phase = prior?.phase ?? 'waiting'
      const phaseStartedAt = prior?.phaseStartedAt ?? at
      const stepStartedAt = prior?.stepStartedAt ?? at
      const message = formatTurnStatus(phase, at - phaseStartedAt, at - stepStartedAt, pendingSteering.length)
      const loader = new Loader(ui, text => palette.accent(text), text => palette.muted(text), message)
      statusContainer.addChild(loader)
      const running: RunningStatus = {
        loader,
        phase,
        phaseStartedAt,
        stepStartedAt,
        timer: setInterval(() => { renderStatus(running) }, STATUS_ELAPSED_INTERVAL_MS),
      }
      runningStatus = running
      runtime.terminal.setProgress(true)
    }
    requestRender()
  }

  // Refresh the running status line's queued-steering badge from the current
  // count; a no-op when idle because the controller only exists while running.
  const refreshStatus = (): void => {
    if (runningStatus !== undefined) renderStatus(runningStatus)
    requestRender()
  }

  // Derive the status-line phase from live session lifecycle events. The event
  // map is merge-extensible, so unhandled types fall through the default.
  const advanceTurnPhase = (event: SessionEvent): void => {
    switch (event.type) {
      case 'step/start':
        enterPhase('waiting', true)
        break
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'reasoning-delta' || (chunk.type === 'block-start' && chunk.blockType === 'reasoning')) {
          enterPhase('thinking', false)
        } else if (chunk.type === 'text-delta' || (chunk.type === 'block-start' && chunk.blockType === 'text')) {
          enterPhase('responding', false)
        }
        break
      }
      case 'tool/call':
        enterPhase('executing', false)
        break
      default:
        break
    }
  }

  const parsedTool = (event: Extract<SessionEvent, { type: 'tool/call' }>): ToolCardComponent => {
    const parsed = parseArguments(event.data.arguments)
    const card = new ToolCardComponent(
      event.data.name,
      parsed,
      ctx.tools.get(event.data.name, agent),
      resolved.maxToolOutputLines,
      palette,
    )
    card.setExpanded(toolsExpanded)
    toolCards.set(event.data.callId, card)
    allToolCards.add(card)
    return card
  }

  const clearStreaming = (): void => {
    if (streaming === undefined) return
    const index = chat.children.indexOf(streaming)
    /* v8 ignore next -- streaming is assigned only after the same component is added, and every removal clears it. */
    if (index >= 0) chat.children.splice(index, 1)
    streaming = undefined
  }

  const renderEvent = (event: SessionEvent, options: { addHistory: boolean; renderChunks: boolean }): void => {
    switch (event.type) {
      case 'user/message': {
        const text = displayText(contentText(displayPromptContent(event.data)).trim())
        if (text) {
          chat.addChild(new Spacer(1))
          chat.addChild(new UserMessageComponent(text, palette, mdTheme))
          if (options.addHistory) editor.addToHistory(text)
        }
        for (const references of promptReferenceCards(event)) {
          chat.addChild(new Spacer(1))
          chat.addChild(new Text(palette.dim(`Referenced sessions · ${references.map(displayText).join(', ')}`), 1, 0))
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
          chat.addChild(new Text(palette.dim(`Referenced sessions · ${references.map(displayText).join(', ')}`), 1, 0))
        }
        break
      }
      case 'context/message': {
        const references = sessionReferenceCard(event.data.meta)
        if (references !== undefined) {
          chat.addChild(new Spacer(1))
          chat.addChild(new Text(palette.dim(`Referenced sessions · ${references.map(displayText).join(', ')}`), 1, 0))
          break
        }
        const text = displayText(contentText(event.data.content).trim())
        if (text) {
          const source = event.data.source.kind === 'plugin' ? event.data.source.plugin : event.data.source.kind
          chat.addChild(new Spacer(1))
          chat.addChild(new Text(palette.dim(`Context · ${displayText(source)}`), 1, 0))
          chat.addChild(new Text(palette.muted(text), 1, 0))
        }
        break
      }
      case 'prompt/blocked':
        appendNotice(`Prompt blocked: ${event.data.reason}`, 'warning')
        break
      case 'assistant/chunk':
        if (options.renderChunks) {
          if (streaming === undefined) {
            streaming = new StreamingAssistantComponent(showReasoning, palette, mdTheme)
            chat.addChild(streaming)
          }
          streaming.update(event.data.chunk)
        }
        break
      case 'assistant/message': {
        clearStreaming()
        const component = new AssistantMessageComponent(event.data.content, showReasoning, palette, mdTheme)
        if (component.children.length > 0) chat.addChild(component)
        break
      }
      case 'llm/retry': {
        clearStreaming()
        appendNotice(
          `Retrying model request (${event.data.retry}/${event.data.maxRetries}) in ${event.data.delayMs}ms: ${event.data.failure.message}`,
          'warning',
        )
        break
      }
      case 'tool/call':
        chat.addChild(new Spacer(1))
        chat.addChild(parsedTool(event))
        break
      case 'tool/result': {
        let card = toolCards.get(event.data.callId)
        if (card === undefined) {
          card = new ToolCardComponent('tool', { value: {}, valid: true }, undefined, resolved.maxToolOutputLines, palette)
          chat.addChild(new Spacer(1))
          chat.addChild(card)
          allToolCards.add(card)
        }
        card.updateResult(event.data)
        toolCards.delete(event.data.callId)
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
      case 'turn/end':
        clearStreaming()
        if (event.data.reason.kind === 'error') {
          const key = `${event.data.turn}:${event.data.reason.step}`
          const message = 'failure' in event.data.reason
            ? event.data.reason.failure.message
            : event.data.reason.message
          if (!liveErrors.delete(key)) appendNotice(message, 'error')
        } else if (event.data.reason.kind === 'aborted') {
          appendNotice('Turn cancelled.', 'warning')
        } else if (event.data.reason.kind === 'max-tokens') {
          appendNotice('The model reached its output-token limit.', 'warning')
        } else if (event.data.reason.kind === 'rejected') {
          appendNotice(`Turn rejected: ${event.data.reason.reason}`, 'warning')
        } else if (event.data.reason.kind === 'interrupted') {
          appendNotice('The previous process ended during this turn.', 'warning')
        }
        break
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
        || event.type === 'context/message'
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
      .sort((a, b) => b.createdAt - a.createdAt)
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
    Object.assign(palette, createPalette(resolved.color, scheme))
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
    if (activeStreaming !== undefined) {
      streaming = activeStreaming
      streaming.setShowReasoning(showReasoning)
      chat.addChild(activeStreaming)
    }
    appendNotice(`Reasoning blocks ${showReasoning ? 'shown' : 'hidden'}.`)
  }

  const showHelp = (): void => {
    const commandLines = ctx.commands.list(agent).map((command) => {
      const input = command.input === undefined ? '' : ` ${command.input.hint}`
      return `/${command.name}${input} — ${command.description}`
    })
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Keyboard shortcuts')), 1, 0))
    chat.addChild(new Text([
      'Enter send • Shift/Alt+Enter newline • Up/Down prompt history',
      'Esc cancel active turn • Ctrl+O toggle tool cards • Ctrl+R toggle reasoning',
      'Ctrl+C cancel while running; clear input or exit while idle • Ctrl+D exit',
      '',
      ...commandLines,
      '/skill:<name> [instructions] — load a skill into the conversation',
    ].map(line => palette.muted(line)).join('\n'), 1, 0))
    requestRender()
  }

  const showStatus = (): void => {
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
    const groups: readonly (readonly StatusCardRow[])[] = [
      [
        ['Session', displayText(agent.session.id)],
        ['Title', displayText(sessionTitle ?? 'untitled')],
        ['Directory', displayText(cwd)],
        ['Model', `${model} ${palette.dim(`(reasoning ${showReasoning ? 'shown' : 'hidden'})`)}`],
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
        skillCommands = summaries.map(skill => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          argumentHint: '[instructions]',
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
      description: 'Show detailed session diagnostics',
      handler: () => { showStatus(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'exit',
      description: 'Exit after the active turn reaches idle',
      handler: () => { requestExit(); return { kind: 'success' } },
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
      agent.send(content, { contexts })
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

  /**
   * List this workspace's resumable sessions, newest first, each with its
   * resume command and a marker on the current one. Warns when resume is not
   * configured or no persistence backend is mounted; notes when nothing is
   * persisted yet. The listing is asynchronous (a persistence scan), so the
   * transcript updates once it resolves.
   */
  const showResume = (): void => {
    const template = config.resumeCommand
    if (template === undefined) {
      appendNotice('Resume is not configured for this app.', 'warning')
      return
    }
    if (persistence === undefined) {
      appendNotice('Resume is not available: no persistence backend is mounted.', 'warning')
      return
    }
    void listWorkspaceSessions().then((sessions) => {
      if (sessions.length === 0) {
        appendNotice('No resumable sessions found for this workspace yet.', 'info')
        return
      }
      chat.addChild(new Spacer(1))
      chat.addChild(new Text(palette.bold(palette.accent('Resumable sessions')), 1, 0))
      const lines = sessions.map((header) => {
        const when = new Date(header.createdAt).toISOString().slice(0, 16).replace('T', ' ')
        const marker = header.id === agent.session.id ? palette.success(' (current)') : ''
        return `${palette.muted(when)}${marker}\n  ${displayText(template.replaceAll('{session}', header.id))}`
      })
      chat.addChild(new Text(lines.join('\n'), 1, 0))
      requestRender()
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
      const { name, instructions } = parseSkillCommand(text)
      if (name === '') appendNotice('Usage: /skill:<name> [instructions]', 'warning')
      else invokeSkill(name, instructions)
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
    advanceTurnPhase(event)
    if (event.type === 'steering/message') {
      // A queued steering message reached the model as it drained; drop its
      // entry from the badge. Matching by source keeps loop-authored steering
      // (e.g. continuation reasons), which logs here without a matching
      // `agent/queued` increment, from consuming a pending user slot.
      const drained = pendingSteering.indexOf(JSON.stringify(event.data.source))
      if (drained >= 0) {
        pendingSteering.splice(drained, 1)
        refreshStatus()
      }
    }
    if ('surfaceOp' in event && typeof event.surfaceOp === 'object') {
      rebuildTranscript(false)
      return
    }
    renderEvent(event, { addHistory: false, renderChunks: true })
    requestRender()
  })
  const disposeQueued = ctx.on('agent/queued', (subject, _content, info) => {
    if (subject !== agent || !info.steering) return
    pendingSteering.push(JSON.stringify(info.source))
    refreshStatus()
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
  // boundary from COLORTERM; an explicit `truecolor` config value still wins.
  const truecolor = config.truecolor ?? ['truecolor', '24bit'].includes(process.env.COLORTERM ?? '')
  mountTui(ctx, Object.assign({}, config, { truecolor }), {
    terminal: new ProcessTerminal(),
    exit: code => process.exit(code),
  })
}
/* v8 ignore stop */
