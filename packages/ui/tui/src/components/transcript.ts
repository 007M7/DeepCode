/**
 * pi-tui transcript components: the startup banner, user/assistant messages,
 * per-step timing footer, streaming assistant buffer, tool cards, and the todo
 * panel. Each is a pure function of its inputs and the active palette.
 * @module @deepseek-ai/dsh-tui/components/transcript
 */

import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import type {
  TerminalCallView,
  ToolCallView,
  ToolDefinition,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { renderUnknownXml } from './xml-tool-output.ts'
import { displayInlineText, displayText } from './text.ts'
import { gradientText, type Palette } from './theme.ts'
import { contentText, type ParsedArguments } from './content.ts'
import {
  formatCompletionTime,
  formatTimingTotals,
  stepTimingAt,
  type StepPosition,
} from '../chat/timing.ts'

/** Concatenate the text of every block of one type, separated by blank lines. */
function textBlocks(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: typeof type }> => block.type === type)
    .map(block => block.text)
    .join('\n\n')
}

/** Render a value as terminal-safe text: strings escaped, other values as pretty JSON. */
function pretty(value: unknown): string {
  if (typeof value === 'string') return displayText(value)
  // JSON.stringify is typed to return string but yields undefined for e.g. symbols.
  const serialized = JSON.stringify(value, null, 2) as string | undefined
  return displayText(serialized ?? String(value))
}

/** A file diff as colored `+`/`-` lines, optionally prefixed with its path. */
function diffLines(diff: FileDiff, palette: Palette): string[] {
  // The card header is a fixed `Tool / <name>` frame that never names a file, so
  // each hunk always carries its own path header (no redundancy to suppress).
  const lines = [palette.bold(displayText(diff.path))]
  if (diff.oldText !== null) {
    for (const line of displayText(diff.oldText).split('\n')) lines.push(palette.removed(`- ${line}`))
  }
  for (const line of displayText(diff.newText).split('\n')) lines.push(palette.added(`+ ${line}`))
  return lines
}

/**
 * A message's bold, underlined role header in the role color. The underline
 * bands each role without a background fill or per-line prefix, so it reads on
 * any theme and a body drag-select copies the message text verbatim.
 */
function messageHeader(label: string, color: (text: string) => string, palette: Palette): string {
  return palette.bold(palette.underline(color(displayText(label))))
}

/**
 * Borderless startup banner: product title, an optional configured subtitle,
 * and the session id. No box frame — each line renders as plain left-padded
 * text (matching transcript notices) so it reads on any theme.
 */
export class HeaderComponent implements Component {
  /** Columns of the banner currently revealed; `undefined` renders it whole. */
  private revealWidth: number | undefined

  constructor(
    private readonly agent: Agent,
    private readonly subtitle: () => string | undefined,
    private readonly palette: Palette,
    private readonly gradient: boolean,
  ) {}

  /**
   * Clip the banner to `width` columns (the sweep reveal); `undefined` restores it.
   * @param width - Revealed banner width in columns, or `undefined` for the whole banner.
   */
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
    const detail = displayText(this.agent.session.id)
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

/**
 * A user or steering prompt in the transcript. An underlined accent role header
 * plus blank-line spacing separate it from surrounding blocks; body lines carry
 * no prefix or indent, so a terminal drag-select copies the prompt verbatim.
 */
export class UserMessageComponent extends Container {
  constructor(text: string, palette: Palette, mdTheme: MarkdownTheme, label = 'You') {
    super()
    this.addChild(new Text(messageHeader(label, palette.accent, palette), 0, 0))
    this.addChild(new Markdown(displayText(text), 0, 0, mdTheme, { color: value => palette.text(value) }, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
    }))
  }
}

/** Children of a settled assistant message: optional reasoning block then the response text. */
function assistantMessageChildren(
  content: readonly ContentBlock[],
  showReasoning: boolean,
  palette: Palette,
  mdTheme: MarkdownTheme,
): Component[] {
  const reasoning = displayText(textBlocks(content, 'reasoning').trim())
  const text = displayText(textBlocks(content, 'text').trim())
  const children: Component[] = [
    new Spacer(1),
    new Text(messageHeader('Assistant', palette.accent2, palette), 0, 0),
  ]
  if (reasoning && showReasoning) {
    children.push(
      new Text(palette.italic(palette.muted('Reasoning')), 0, 0),
      new Markdown(reasoning, 0, 0, mdTheme, { color: value => palette.muted(value), italic: true }),
    )
  }
  if (text) children.push(new Markdown(text, 0, 0, mdTheme, { color: value => palette.text(value) }))
  return children
}

/**
 * A step's timing summary, rendered as a self-refreshing footer that stays at
 * the tail of the step's output. Kept separate from the assistant message so
 * the timing line trails any tool cards the step appends after its message.
 */
class StepTimingComponent extends Container {
  private completionTime: number | undefined

  constructor(
    private readonly position: StepPosition,
    private readonly events: () => readonly SessionEvent[],
    private readonly now: () => number,
    private readonly palette: Palette,
  ) {
    super()
    this.rebuild()
  }

  complete(time: number): void {
    this.completionTime = time
    this.rebuild()
  }

  override invalidate(): void {
    this.rebuild()
    super.invalidate()
  }

  private rebuild(): void {
    this.clear()
    const totals = stepTimingAt(this.events(), this.position, this.completionTime ?? this.now())
    const timing = formatTimingTotals(totals, true)
    const header = this.completionTime === undefined
      ? timing
      : `${timing} · Completed ${formatCompletionTime(this.completionTime)}`
    this.addChild(new Text(this.palette.dim(header), 0, 0))
  }
}

interface StreamingBlock {
  type: string
  text: string
}

/** A live assistant step: streamed reasoning/text blocks until the message settles. */
export class StreamingAssistantComponent extends Container {
  private readonly blocks = new Map<number, StreamingBlock>()
  private settledContent: readonly ContentBlock[] | undefined
  /**
   * The step's timing footer. The renderer keeps it at the tail of the chat so
   * it trails any tool cards the step appends after this assistant message; it
   * is not a child of this component.
   */
  readonly timing: StepTimingComponent

  constructor(
    position: StepPosition,
    events: () => readonly SessionEvent[],
    now: () => number,
    private showReasoning: boolean,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
  ) {
    super()
    this.timing = new StepTimingComponent(position, events, now, palette)
    this.rebuild()
  }

  /**
   * Replace the streamed blocks with the step's settled content.
   * @param content - The settled assistant content blocks.
   */
  settle(content: readonly ContentBlock[]): void {
    this.settledContent = content
    this.rebuild()
  }

  /**
   * Whether this step's assistant message has settled.
   * @returns `true` once {@link settle} has run.
   */
  isSettled(): boolean {
    return this.settledContent !== undefined
  }

  /**
   * Pin the step's timing footer to its completion time.
   * @param time - Step completion time in epoch milliseconds.
   */
  complete(time: number): void {
    this.timing.complete(time)
  }

  override invalidate(): void {
    this.rebuild()
    this.timing.invalidate()
    super.invalidate()
  }

  /**
   * Fold one streamed chunk into the live block buffer and re-render.
   * @param chunk - The streamed assistant chunk.
   */
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
    this.timing.invalidate()
  }

  /**
   * Toggle whether reasoning blocks render, then re-render.
   * @param show - Whether to show reasoning blocks.
   */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    this.rebuild()
  }

  private rebuild(): void {
    this.clear()
    const content: readonly ContentBlock[] = this.settledContent ?? [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap<ContentBlock>(([, block]) => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type === 'reasoning') return [{ type: 'reasoning', text: block.text }]
        return []
      })
    for (const child of assistantMessageChildren(content, this.showReasoning, this.palette, this.mdTheme)) {
      this.addChild(child)
    }
  }
}

/** A tool call and its result, rendered as a collapsible status card. */
export class ToolCardComponent implements Component {
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
    private readonly mdTheme: MarkdownTheme,
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

  /**
   * Record the tool result and derive its result view.
   * @param event - The `tool/result` event payload.
   */
  updateResult(event: Extract<SessionEvent, { type: 'tool/result' }>['data']): void {
    const result = event.message.content[0]
    this.result = {
      content: [...result.content],
      isError: result.isError === true,
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

  /**
   * Expand or collapse the card's body preview.
   * @param expanded - Whether the full body is shown.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  invalidate(): void {}

  render(width: number): string[] {
    const isError = this.result?.isError ?? false
    // A ring marker: hollow while the call is pending, filled once it settles;
    // the header color (warning/success/error) tells pending from ok from error.
    const glyph = this.result === undefined ? '○' : '●'
    const rawBody = this.renderBody()
    const view = this.resultView ?? this.callView
    const genericContent = view.card === 'generic' ? view.content ?? this.result?.content : undefined
    const unknownXml = this.definition === undefined && genericContent !== undefined
      ? renderUnknownXml(
        displayText(contentText(genericContent)),
        this.maxOutputLines,
        this.expanded,
        displayText,
        text => this.palette.muted(text),
        /* v8 ignore next -- renderUnknownXml calls the collapsed summary only when hidden XML children exceed this card's limit. */
        count => this.palette.dim(`  … +${count} lines (Ctrl+O to expand)`),
      )
      : undefined
    const body = unknownXml ?? (genericContent !== undefined && rawBody.length > 0
      ? new Markdown(rawBody.join('\n'), 0, 0, this.mdTheme, { color: value => this.palette.text(value) }).render(width)
      : rawBody)
    const headLines = Math.ceil(this.maxOutputLines / 2)
    const tailLines = this.maxOutputLines - headLines
    const visibleBody = unknownXml !== undefined || this.expanded || body.length <= this.maxOutputLines
      ? body
      : [
        ...body.slice(0, headLines),
        this.palette.dim(`… +${body.length - this.maxOutputLines} lines (Ctrl+O to expand)`),
        ...body.slice(body.length - tailLines),
      ]
    // The header is a fixed `Tool / <name>` frame in the status color (warning
    // pending / success ok / error), flat — no bold or underline, so one color
    // reads consistently across the whole row. Every tool-specific detail (a
    // read's path, a diff, command output) lives in the body below; the sole
    // header extra is a bash card's model-authored description, appended as a
    // `/ <desc>` segment. The body stays unprefixed so a drag-select copies only
    // the tool text; body lines pass through Text so overlong output wraps.
    const statusColor = this.result === undefined
      ? this.palette.warning
      : isError ? this.palette.error : this.palette.success
    // The header is a single card row: collapse an embedded newline in the
    // description to an inline escape so it cannot break onto extra rows and
    // collide with the body lines that follow.
    const desc = this.headerDescription()
    const headerText = `${glyph} Tool / ${displayText(this.name)}${desc === undefined ? '' : ` / ${displayInlineText(desc)}`}`
    const header = truncateToWidth(headerText, Math.max(1, width - 2), '')
    const lines = [statusColor(header)]
    if (visibleBody.length > 0) lines.push(...new Text(visibleBody.join('\n'), 0, 0).render(width))
    return lines
  }

  /** The pending terminal call view, when this row is a terminal card. */
  private terminalPending(): TerminalCallView | undefined {
    return this.callView.card === 'terminal' ? this.callView : undefined
  }

  /**
   * The optional header `/ <desc>` segment: a bash (terminal) card's
   * model-authored description. Non-terminal tools contribute no header detail —
   * their presenter title moves into the body instead.
   */
  private headerDescription(): string | undefined {
    const description = this.terminalPending()?.description
    return description !== undefined && description !== '' ? description : undefined
  }

  /**
   * The presenter's title for a non-terminal card, shown as the first body line
   * (a read's `Read src/foo.ts`, a diff's `Edit files`) now that the header is a
   * fixed `Tool / <name>` frame. The result-state title replaces the pending one.
   */
  private bodyTitle(): string {
    return this.resultView?.title ?? this.callView.title
  }

  private renderBody(): string[] {
    const view = this.resultView ?? this.callView
    if (view.card === 'terminal') {
      const pending = this.terminalPending()
      const lines: string[] = []
      // The command shows as a $-line here whenever it is not the header: either a
      // description headlines the row (the command still belongs somewhere) or the row
      // is a pending undescribed call (the classic running-command echo). A completed
      // undescribed row keeps the command only in the header.
      // The command and cwd are each a single card row, so escape a multi-line
      // command inline (displayInlineText) — a real newline would break onto extra
      // rows and collide with the output below.
      const headlined = pending?.description !== undefined && pending.description !== ''
      const commandInBody = pending !== undefined && (headlined || this.result === undefined)
      if (commandInBody) lines.push(this.palette.code(`$ ${displayInlineText(pending.title)}`))
      if (pending?.cwd) lines.push(this.palette.dim(displayInlineText(pending.cwd)))
      if (this.resultView?.card === 'terminal') {
        if (this.resultView.output) lines.push(...displayText(this.resultView.output).split('\n'))
        if (this.resultView.exitCode !== undefined) lines.push(this.palette.dim(`[exit ${this.resultView.exitCode}]`))
        if (this.resultView.signal !== undefined) {
          lines.push(this.palette.error(`[signal ${displayText(this.resultView.signal)}]`))
        }
      } else if (this.result !== undefined) {
        lines.push(...displayText(contentText(this.result.content)).split('\n'))
      }
      return lines.filter(Boolean)
    }
    if (view.card === 'diff') {
      // The header no longer names the file, so each diff keeps its own path
      // header. A trailing footer summarizes the change (`+A -R · N file(s)`).
      let added = 0
      let removed = 0
      const hunks = view.diffs.flatMap((diff, index) => {
        if (diff.oldText !== null) removed += displayText(diff.oldText).split('\n').length
        added += displayText(diff.newText).split('\n').length
        return [...index > 0 ? [''] : [], ...diffLines(diff, this.palette)]
      })
      const files = view.diffs.length
      const footer = this.palette.dim(`└ +${added} -${removed} · ${files} file${files === 1 ? '' : 's'}`)
      return [...hunks, footer]
    }
    const content = view.content ?? this.result?.content
    const lines: string[] = []
    // The presenter title headlines the body now that the header is a fixed
    // `Tool / <name>` frame (a terminal card keeps its command $-line instead).
    // Skip it when it only repeats the tool name (the fallback presenter for a
    // tool with no presentCall, or an unknown tool), which the header already shows.
    const bodyTitle = this.bodyTitle()
    if (bodyTitle !== displayText(this.name)) lines.push(displayInlineText(bodyTitle))
    if (content !== undefined) lines.push(...displayText(contentText(content)).split('\n'))
    const rawInput = this.result === undefined && this.callView.card === 'generic'
      ? this.callView.rawInput
      : undefined
    if (rawInput !== undefined) lines.push(...pretty(rawInput).split('\n'))
    return lines.filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1))
  }
}

/** The plan/todo panel rendered above the prompt. */
export class TodoComponent implements Component {
  private todos: readonly TodoItem[] = []

  constructor(private readonly palette: Palette) {}

  /**
   * Replace the rendered plan items.
   * @param todos - The current todo items.
   */
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
