/**
 * Interactive pi-tui front door for DeepSeek Harness agents. It renders the
 * durable session transcript, drives one configured agent, and provides
 * keyboard-driven user-interaction dialogs without owning agent lifecycle.
 * @module @deepseek-ai/dsh-tui
 */

import { homedir } from 'node:os'
import { relative, resolve, sep } from 'node:path'
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
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type MarkdownTheme,
  type OverlayHandle,
  type SelectListTheme,
  type Terminal,
} from '@earendil-works/pi-tui'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type TodoItem } from '@deepseek-ai/dsh-session'
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

export const name = 'ui-tui'
export const inject = ['agents', 'userInteraction', 'tools']

/** Presentation settings for the pi-tui terminal mode. */
export interface TuiConfig {
  /** Render model reasoning blocks. */
  showReasoning?: boolean
  /** Maximum tool-output lines shown before the card is collapsed. */
  maxToolOutputLines?: number
  /** Maximum options visible at once in a user-question dialog. */
  maxQuestionOptions?: number
  /** User-question dialog width in terminal columns. */
  questionDialogWidth?: number
  /** User-question dialog maximum height in terminal rows. */
  questionDialogMaxHeight?: number
  /** Show the terminal's hardware cursor at the pi editor's IME marker. */
  showHardwareCursor?: boolean
  /** Apply the built-in ANSI color palette. */
  color?: boolean
  /** Terminal window title while the UI is mounted. */
  title?: string
}

const showReasoningSchema = z.boolean().default(true)
const maxToolOutputLinesSchema = z.number().step(1).min(1).default(12)
const maxQuestionOptionsSchema = z.number().step(1).min(1).default(8)
const questionDialogWidthSchema = z.number().step(1).min(20).default(72)
const questionDialogMaxHeightSchema = z.number().step(1).min(6).default(20)
const showHardwareCursorSchema = z.boolean().default(false)
const colorSchema = z.boolean().default(true)
const titleSchema = z.string().default('DeepSeek Harness')

/** Schemastery schema for presentation settings embedded by app bundles. */
export const TuiConfigSchema: z<TuiConfig> = z.object({
  showReasoning: showReasoningSchema,
  maxToolOutputLines: maxToolOutputLinesSchema,
  maxQuestionOptions: maxQuestionOptionsSchema,
  questionDialogWidth: questionDialogWidthSchema,
  questionDialogMaxHeight: questionDialogMaxHeightSchema,
  showHardwareCursor: showHardwareCursorSchema,
  color: colorSchema,
  title: titleSchema,
})

/** Serializable plugin configuration. */
export interface Config extends TuiConfig {
  /** Header subtitle. Defaults to `ready.`. */
  welcome?: string
  /** Exact shared agent/session identity driven by this terminal. Defaults to `main`. */
  sessionId?: string
}

export const Config: z<Config> = z.object({
  welcome: z.string().default('ready.'),
  sessionId: z.string().default('main'),
  showReasoning: showReasoningSchema,
  maxToolOutputLines: maxToolOutputLinesSchema,
  maxQuestionOptions: maxQuestionOptionsSchema,
  questionDialogWidth: questionDialogWidthSchema,
  questionDialogMaxHeight: questionDialogMaxHeightSchema,
  showHardwareCursor: showHardwareCursorSchema,
  color: colorSchema,
  title: titleSchema,
})

/** Fully defaulted TUI presentation settings. */
export interface ResolvedTuiConfig {
  showReasoning: boolean
  maxToolOutputLines: number
  maxQuestionOptions: number
  questionDialogWidth: number
  questionDialogMaxHeight: number
  showHardwareCursor: boolean
  color: boolean
  title: string
}

/** Runtime boundary used by the interactive TUI. */
export interface TuiRuntime {
  /** Terminal implementation; production uses pi-tui's `ProcessTerminal`. */
  terminal: Terminal
  /** Exit hook used by terminal shutdown or a target-agent startup failure. */
  exit(code: number): void
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
    maxToolOutputLines: config?.maxToolOutputLines ?? 12,
    maxQuestionOptions: config?.maxQuestionOptions ?? 8,
    questionDialogWidth: config?.questionDialogWidth ?? 72,
    questionDialogMaxHeight: config?.questionDialogMaxHeight ?? 20,
    showHardwareCursor: config?.showHardwareCursor ?? false,
    color: config?.color ?? true,
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

/** Render an arbitrary failure without allowing hostile coercion to escape the UI boundary. */
function renderThrown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/**
 * Theme-agnostic palette built from the standard 16-color ANSI set plus SGR
 * attributes, which every terminal remaps to its active color scheme. Body
 * `text` stays the terminal's default foreground so it reads on light and dark
 * backgrounds alike; grouping uses foreground-only gutter bars and reverse
 * video rather than fixed background fills.
 */
function createPalette(enabled: boolean): Palette {
  return {
    accent: ansi('94', '39', enabled),
    accent2: ansi('95', '39', enabled),
    text: text => text,
    muted: ansi('90', '39', enabled),
    dim: ansi('2', '22', enabled),
    success: ansi('32', '39', enabled),
    warning: ansi('33', '39', enabled),
    error: ansi('31', '39', enabled),
    code: ansi('36', '39', enabled),
    added: ansi('32', '39', enabled),
    removed: ansi('31', '39', enabled),
    bold: ansi('1', '22', enabled),
    italic: ansi('3', '23', enabled),
    underline: ansi('4', '24', enabled),
    strike: ansi('9', '29', enabled),
    selected: ansi('7', '27', enabled),
  }
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

class HeaderComponent implements Component {
  constructor(
    private readonly agent: Agent,
    private readonly welcome: string,
    private readonly palette: Palette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const usable = Math.max(1, width - 4)
    const title = `${this.palette.bold(this.palette.accent('DEEPSEEK'))} ${this.palette.bold('HARNESS')}`
    const model = displayText(this.agent.options.model ?? 'model unset')
    const detail = `${model}  •  ${displayText(this.agent.session.id)}`
    const top = this.palette.accent(`╭${'─'.repeat(Math.max(0, width - 2))}╮`)
    const bottom = this.palette.accent(`╰${'─'.repeat(Math.max(0, width - 2))}╯`)
    const lines = [title, this.palette.muted(displayText(this.welcome)), this.palette.dim(detail)]
      .flatMap(line => wrapTextWithAnsi(line, usable))
      .map((line) => {
        const clipped = truncateToWidth(line, usable, '')
        return `${this.palette.accent('│')} ${clipped}${' '.repeat(Math.max(0, usable - visibleWidth(clipped)))} ${this.palette.accent('│')}`
      })
    return [top, ...lines, bottom]
  }
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
  private result: { content: ContentBlock[]; isError: boolean; meta?: unknown } | undefined
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
    const visibleBody = this.expanded || body.length <= this.maxOutputLines
      ? body
      : [...body.slice(0, this.maxOutputLines), this.palette.dim(`… ${body.length - this.maxOutputLines} more lines (Ctrl+O to expand)`)]
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
  if (rel !== '..' && !rel.startsWith(`..${sep}`)) return displayText(`~${sep}${rel}`)
  return displayText(cwd)
}

function sessionTokens(session: Session): { input: number; output: number } {
  let input = 0
  let output = 0
  for (const event of session.events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    input += event.data.usage.inputTokens
    output += event.data.usage.outputTokens
  }
  return { input, output }
}

class FooterComponent implements Component {
  constructor(
    private readonly agent: Agent,
    private readonly palette: Palette,
    private readonly toolsExpanded: () => boolean,
    private readonly showReasoning: () => boolean,
    private readonly tokens: () => { input: number; output: number },
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { input, output } = this.tokens()
    const left = `${formatCwd(this.agent.session.header.cwd)}  ↑${formatTokens(input)} ↓${formatTokens(output)}`
    const right = `${this.agent.status}  reasoning:${this.showReasoning() ? 'on' : 'off'}  tools:${this.toolsExpanded() ? 'expanded' : 'compact'}`
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
        this.error = 'Select at least one option, or press C for a custom answer.'
        return
      }
      this.done({ selected: indices.map(index => options[index]?.label).filter((label): label is string => label !== undefined) })
    } else if (data.toLowerCase() === 'c') {
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
    const title = displayText(this.question.header ?? 'Question')
    const topLabel = ` ${title} `
    const top = `╭${topLabel}${'─'.repeat(Math.max(0, width - visibleWidth(topLabel) - 2))}╮`
    const lines: string[] = [this.palette.accent(top)]
    const push = (line: string): void => {
      const clipped = truncateToWidth(line, innerWidth, '')
      lines.push(`${this.palette.accent('│')} ${clipped}${' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${this.palette.accent('│')}`)
    }
    for (const line of wrapTextWithAnsi(this.palette.bold(displayText(this.question.question)), innerWidth)) push(line)
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
      for (let index = start; index < end; index += 1) {
        // `index < end <= options.length`; the options array is borrowed immutably for this dialog.
        const option = options[index] as NonNullable<AskUserQuestionItem['options']>[number]
        const cursor = index === this.selectedIndex ? this.palette.accent('›') : ' '
        const mark = this.question.multiSelect
          ? this.selected.has(index) ? this.palette.success('[x]') : '[ ]'
          : index === this.selectedIndex ? this.palette.accent('●') : this.palette.dim('○')
        const description = option.description
          ? this.palette.muted(` — ${displayText(option.description)}`)
          : ''
        const line = `${cursor} ${mark} ${displayText(option.label)}${description}`
        push(index === this.selectedIndex ? this.palette.selected(line) : line)
      }
      if (options.length > this.maxVisible) push(this.palette.dim(`${this.selectedIndex + 1}/${options.length}`))
      push(this.palette.dim(this.question.multiSelect
        ? '↑↓ navigate • Space toggle • Enter submit • C custom • Esc cancel'
        : '↑↓ navigate • Enter select • C custom • Esc cancel'))
    }
    if (this.error) push(this.palette.error(this.error))
    lines.push(this.palette.accent(`╰${'─'.repeat(Math.max(0, width - 2))}╯`))
    return lines
  }
}

interface PendingQuestion {
  request: AskUserQuestionRequest
  index: number
  answers: AskUserQuestionAnswerItem[]
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: unknown): void
  onAbort: () => void
  overlay: OverlayHandle | undefined
}

/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
  /** Stop rendering, restore the terminal, and reject pending questions. */
  dispose(): Promise<void>
}

function activeSurfaceSeqs(session: Session): Set<number> {
  return new Set(session.surface.nodes)
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
  let statusLoader: Loader | undefined
  let disposed = false
  let shuttingDown: Promise<void> | undefined
  const tokens = sessionTokens(agent.session)
  const toolCards = new Map<string, ToolCardComponent>()
  const allToolCards = new Set<ToolCardComponent>()
  const liveErrors = new Set<string>()
  const questionQueue: PendingQuestion[] = []
  let activeQuestion: PendingQuestion | undefined

  const welcome = config.welcome ?? 'ready.'
  const header = new HeaderComponent(agent, welcome, palette)
  const footer = new FooterComponent(agent, palette, () => toolsExpanded, () => showReasoning, () => tokens)
  ui.addChild(header)
  ui.addChild(chat)
  ui.addChild(statusContainer)
  todoContainer.addChild(todo)
  ui.addChild(todoContainer)
  ui.addChild(editor)
  ui.addChild(footer)
  ui.setFocus(editor)
  runtime.terminal.setTitle(displayText(resolved.title))

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

  const clearStatus = (): void => {
    statusLoader?.stop()
    statusLoader = undefined
    statusContainer.clear()
    runtime.terminal.setProgress(false)
  }

  const setStatus = (status: AgentStatus): void => {
    clearStatus()
    editor.borderColor = status === 'running' ? text => palette.accent(text) : text => palette.dim(text)
    if (status === 'running') {
      statusLoader = new Loader(ui, text => palette.accent(text), text => palette.muted(text), 'Working — Enter sends steering, Esc cancels')
      statusContainer.addChild(statusLoader)
      runtime.terminal.setProgress(true)
    }
    requestRender()
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

  const renderEvent = (event: SessionEvent, options: { addHistory: boolean; renderChunks: boolean }): void => {
    switch (event.type) {
      case 'user/message': {
        const text = displayText(contentText(event.data.content).trim())
        if (text) {
          chat.addChild(new Spacer(1))
          chat.addChild(new UserMessageComponent(text, palette, mdTheme))
          if (options.addHistory) editor.addToHistory(text)
        }
        break
      }
      case 'steering/message': {
        const text = displayText(contentText(event.data.content).trim())
        if (text) {
          chat.addChild(new Spacer(1))
          chat.addChild(new UserMessageComponent(text, palette, mdTheme, 'Steering'))
        }
        break
      }
      case 'context/message': {
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
        if (streaming !== undefined) {
          const index = chat.children.indexOf(streaming)
          if (index >= 0) chat.children.splice(index, 1)
          streaming = undefined
        }
        const component = new AssistantMessageComponent(event.data.content, showReasoning, palette, mdTheme)
        if (component.children.length > 0) chat.addChild(component)
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
      case 'turn/end':
        if (event.data.reason.kind === 'error') {
          const key = `${event.data.turn}:${event.data.reason.step}`
          if (!liveErrors.delete(key)) appendNotice(event.data.reason.message, 'error')
        } else if (event.data.reason.kind === 'aborted') {
          appendNotice(event.data.reason.reason ?? 'Turn cancelled.', 'warning')
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
    pending.overlay?.hide()
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
      const dialog = new QuestionDialog(
        question,
        resolved.maxQuestionOptions,
        palette,
        (selection) => {
          pending.overlay?.hide()
          pending.overlay = undefined
          pending.answers.push({ id: question.id, ...selection })
          pending.index += 1
          show()
        },
        () => {
          activeQuestion = undefined
          rejectQuestion(pending)
          startNextQuestion()
        },
      )
      pending.overlay = ui.showOverlay(dialog, {
        width: resolved.questionDialogWidth,
        maxHeight: resolved.questionDialogMaxHeight,
        anchor: 'center',
        margin: 1,
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

  const shutdown = (exitProcess: boolean): Promise<void> => {
    shuttingDown ??= (async () => {
      disposed = true
      clearStatus()
      if (activeQuestion !== undefined) {
        const pending = activeQuestion
        activeQuestion = undefined
        rejectQuestion(pending)
      }
      for (const pending of questionQueue.splice(0)) rejectQuestion(pending)
      disposeUserInteraction()
      await runtime.terminal.drainInput(100, 20)
      ui.stop()
      if (exitProcess) runtime.exit(0)
    })()
    return shuttingDown
  }

  const requestExit = (): void => {
    if (agent.status === 'running') {
      agent.cancel('terminal exit requested')
      appendNotice('Cancelling the active turn before exit…', 'warning')
      void agent.whenIdle().then(() => shutdown(true))
      return
    }
    void shutdown(true)
  }

  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
    { name: 'help', description: 'Show keyboard shortcuts and commands' },
    { name: 'clear', description: 'Clear the transcript view (session history is unchanged)' },
    { name: 'cancel', description: 'Cancel the active turn' },
    { name: 'reasoning', description: 'Toggle reasoning blocks' },
    { name: 'tools', description: 'Expand or collapse all tool cards' },
    { name: 'redraw', description: 'Invalidate components and redraw the terminal' },
    { name: 'exit', description: 'Exit after the active turn reaches idle' },
  ], agent.session.header.cwd ?? process.cwd()))

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
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent('Keyboard shortcuts')), 1, 0))
    chat.addChild(new Text([
      'Enter send • Shift/Alt+Enter newline • Up/Down prompt history',
      'Esc cancel active turn • Ctrl+O expand tool cards • Ctrl+R toggle reasoning',
      'Ctrl+C cancel while running; clear input or exit while idle • Ctrl+D exit',
      '/help /clear /cancel /reasoning /tools /redraw /exit',
    ].map(line => palette.muted(line)).join('\n'), 1, 0))
    requestRender()
  }

  editor.onSubmit = (value: string) => {
    const text = value.trim()
    if (text === '') return
    editor.addToHistory(text)
    editor.setText('')
    switch (text) {
      case '/help':
        showHelp()
        return
      case '/clear':
        chat.clear()
        requestRender()
        return
      case '/cancel':
        if (agent.status === 'running') agent.cancel('cancelled from terminal')
        else appendNotice('The agent is already idle.')
        return
      case '/reasoning':
        toggleReasoning()
        return
      case '/tools':
        toggleTools()
        return
      case '/redraw':
        ui.invalidate()
        ui.requestRender(true)
        return
      case '/exit':
        requestExit()
        return
      default:
        if (text.startsWith('/')) {
          appendNotice(`Unknown command: ${text}`, 'warning')
          return
        }
    }
    if (agent.status === 'disposed') {
      appendNotice(`Agent "${agent.id}" is disposed.`, 'error')
    } else if (agent.status === 'running') {
      agent.steer([{ type: 'text', text }])
    } else {
      agent.send([{ type: 'text', text }])
    }
  }

  const removeInputListener = ui.addInputListener((data) => {
    if (activeQuestion !== undefined) return undefined
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
      agent.cancel('cancelled from terminal')
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (agent.status === 'running') {
        agent.cancel('cancelled from terminal')
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
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      tokens.input += event.data.usage.inputTokens
      tokens.output += event.data.usage.outputTokens
    }
    if ('surfaceOp' in event && typeof event.surfaceOp === 'object') {
      rebuildTranscript(false)
      return
    }
    renderEvent(event, { addHistory: false, renderChunks: true })
    requestRender()
  })
  const disposeStatus = ctx.on('agent/status', (subject, status) => {
    if (subject !== agent) return
    setStatus(status)
  })
  const disposeError = ctx.on('agent/error', (subject, turn, step, error) => {
    if (subject !== agent) return
    liveErrors.add(`${turn}:${step}`)
    appendNotice(error.message, 'error')
  })
  const disposeAgent = ctx.on('agent/disposed', (subject) => {
    if (subject !== agent) return
    clearStatus()
    appendNotice(`Agent "${agent.id}" was disposed.`, 'warning')
  })

  const detachListeners = (): void => {
    removeInputListener()
    disposeSessionEvents()
    disposeStatus()
    disposeError()
    disposeAgent()
  }

  rebuildTranscript(true)
  setStatus(agent.status)
  try {
    ui.start()
  } catch (error: unknown) {
    disposed = true
    detachListeners()
    clearStatus()
    disposeUserInteraction()
    ui.stop()
    throw error
  }

  return {
    async dispose(): Promise<void> {
      detachListeners()
      await shutdown(false)
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
    runtime.terminal.write(displayText(`ui-tui: session "${sessionId}" failed to start: ${renderThrown(error)}\n`))
    runtime.exit(1)
  }

  const disposeCreated = ctx.on('agent/created', start)
  const disposeFailure = ctx.on('agent-loop/config-start-failed', fail)
  const existing = ctx.agents.roots().find(agent => agent.id === sessionId)
  if (existing !== undefined) start(existing)
}

/** Cordis entry point using the process terminal; explicit TUI composition requires a TTY pair. */
/* v8 ignore start -- production process wiring; fake-terminal tests cover mountTui/createTuiChat,
   and the coding-agent PTY smoke covers the real entry */
export function apply(ctx: Context, config: Config): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('ui-tui: both stdin and stdout must be TTYs; use @deepseek-ai/dsh-stdio for pipes')
  }
  mountTui(ctx, config, {
    terminal: new ProcessTerminal(),
    exit: code => process.exit(code),
  })
}
/* v8 ignore stop */
