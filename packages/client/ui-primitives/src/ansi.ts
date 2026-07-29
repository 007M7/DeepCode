// ANSI model behind TerminalBlock: anser splits the SGR runs, this module
// resolves each run's colors and decorations into a plain style record and
// folds the runs into per-line span arrays so a height cap can slice whole
// lines. Sequences anser does not turn into color (OSC, cursor movement,
// other C0 controls) are removed before parsing so they never reach the DOM
// as literal characters.

import Anser from 'anser'
import type { CSSProperties } from 'react'

/**
 * The subset of one anser JSON chunk this module reads. anser's own types
 * declare `fg`/`bg` as `string`, but its parser leaves them `null` for a run
 * that sets no color, so the null is spelled out here.
 */
interface AnsiChunk {
  /** Run text with its SGR codes already removed. */
  content: string
  /** Foreground as an `r, g, b` triple, or null when the run sets none. */
  fg: string | null
  /** Background as an `r, g, b` triple, or null when the run sets none. */
  bg: string | null
  /** SGR attributes in effect for the run, in the order they were declared. */
  decorations: readonly string[]
}

/** One run of terminal text; `style` is undefined for text that carries no SGR state. */
export interface AnsiSpan {
  /** The run's plain text, free of escape sequences and newlines. */
  text: string
  /** Resolved inline style, or undefined when the run needs no wrapper. */
  style: CSSProperties | undefined
}

/** The spans of one output line, in order. */
export type AnsiLine = readonly AnsiSpan[]

/**
 * The 8/16 basic ANSI colors, keyed by the whitespace-free `r,g,b` triple
 * anser emits for them, mapped onto the theme tokens that carry the same
 * semantic. Black and white both resolve to the primary label color so text
 * stays legible under either theme instead of matching the surface it sits
 * on; bright black takes the tertiary label color (the muted-gray role).
 * Magenta and cyan have no token equivalent in this design system and fall
 * through to anser's literal rgb, as do all 256-palette and truecolor values.
 */
const TOKEN_BY_BASIC_RGB: Record<string, string> = {
  '0,0,0': 'var(--dsw-alias-label-primary)',
  '255,255,255': 'var(--dsw-alias-label-primary)',
  '85,85,85': 'var(--dsw-alias-label-tertiary)',
  '187,0,0': 'var(--dsw-alias-state-error-primary)',
  '255,85,85': 'var(--dsw-alias-state-error-secondary)',
  '0,187,0': 'var(--dsw-alias-state-success-primary)',
  '0,255,0': 'var(--dsw-alias-state-success-secondary)',
  '187,187,0': 'var(--dsw-alias-state-warn-primary)',
  '255,255,85': 'var(--dsw-alias-state-warn-secondary)',
  '0,0,187': 'var(--dsw-alias-state-business-primary)',
  '85,85,255': 'var(--dsw-static-blue-400)',
}

/**
 * CSS for each SGR attribute anser reports. `blink` is deliberately absent —
 * animated text is not reproduced. `reverse` never arrives here: anser
 * consumes it by swapping the run's foreground and background. Underline and
 * strikethrough share `textDecoration`, so in a run declaring both, the
 * later declaration wins.
 */
const STYLE_BY_DECORATION: Record<string, CSSProperties | undefined> = {
  bold: { fontWeight: 700 },
  dim: { opacity: 0.7 },
  italic: { fontStyle: 'italic' },
  underline: { textDecoration: 'underline' },
  strikethrough: { textDecoration: 'line-through' },
  hidden: { visibility: 'hidden' },
}

/** OSC strings (window title, hyperlinks), with or without their terminator. */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g

/** Escape sequences other than CSI: charset selection, single-shift, reset. */
const NON_CSI_ESCAPE = /\u001b(?!\[)[\u0020-\u002f]*[\u0030-\u007e]?/g

/**
 * C0 controls with no display meaning here. Tab, newline, backspace and ESC
 * survive: the first two for layout, backspace for the cursor replay, ESC
 * for anser's CSI split.
 */
const INERT_CONTROL = /[\u0000-\u0007\u000b-\u001a\u001c-\u001f\u007f]/g

/** Terminal tab stop width; a tab advances to the next multiple of this. */
const TAB_WIDTH = 8

/**
 * Characters a terminal advances two columns for: CJK scripts, fullwidth forms,
 * CJK punctuation, and the emoji/symbol blocks a command's output realistically
 * carries.
 */
const WIDE_CHAR = new RegExp(
  '\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}'
  + '|[\\u{1f300}-\\u{1faff}\\u{2600}-\\u{27bf}\\uff01-\\uff60\\u3000-\\u303e]',
  'u',
)

/**
 * Whether a character occupies two terminal columns (CJK, fullwidth forms,
 * emoji). Covers the ranges a command's output realistically carries; a
 * narrower guess would misalign the columns this card exists to preserve.
 * @param char - one character from the output.
 * @returns true when the terminal advances two columns for it.
 */
function isWide(char: string): boolean {
  const code = char.codePointAt(0)
  if (code === undefined || code < 0x1100) return false
  return WIDE_CHAR.test(char)
}

/**
 * Replay one line's cursor movements the way a terminal paints it, into a
 * column buffer. Carriage return and backspace only MOVE the cursor — neither
 * erases anything — so what a reader sees is whatever each column last had
 * written to it. That distinction is the whole point of doing this as a buffer
 * rather than as string surgery: `100%\rOK` shows `OK0%` because the redraw is
 * shorter than the frame beneath it, and a trailing `abc\b` still shows `abc`
 * because nothing ever overwrote the `c`.
 *
 * A CSI sequence occupies no column; it changes the state that the NEXT writes
 * are stamped with, which is how a terminal stores color per cell. `red bad`
 * then three backspaces then `ok` therefore shows `okd` with the `d` still red:
 * `ok` overwrote two cells and the third kept the state it was written with.
 * The columns are re-emitted as runs, so anser sees that same styling.
 * @param line - one output line, still carrying its CSI sequences.
 * @returns the line as the terminal would have it after every movement.
 */
function replayLine(line: string, entrySgr: string): { text: string; sgr: string } {
  // Same shape anser splits on, so a sequence is one unit here as well.
  const csi = /\u001b\[([\u0030-\u003f]*)[\u0020-\u002f]*([\u0040-\u007e])/g
  /** Per column: the SGR state in force when it was written, and its character. */
  const columns: ({ sgr: string; char: string } | undefined)[] = []
  let cursor = 0
  // SGR state accumulates as the line is scanned, exactly as a terminal tracks
  // it: each cell is stamped with whatever was in force at the moment of the
  // write, so a later redraw cannot restyle the cells it does not reach. It
  // enters carrying the previous line's state, since a newline does not reset it.
  let sgr = entrySgr
  let at = 0

  const consume = (chunk: string): void => {
    for (const char of chunk) {
      if (char === '\r') { cursor = 0; continue }
      if (char === '\u0008') { cursor = Math.max(0, cursor - 1); continue }
      if (char === '\t') {
        // A tab advances to the next 8-column stop, leaving the cells it skips
        // as they were — which is how a redraw can leave a tabbed column
        // standing. Column alignment is the whole point of this card.
        const stop = cursor + TAB_WIDTH - (cursor % TAB_WIDTH)
        for (; cursor < stop; cursor++) columns[cursor] ??= { sgr, char: ' ' }
        continue
      }
      columns[cursor] = { sgr, char }
      cursor++
      // A wide character occupies two columns; the trailing one is a spacer the
      // terminal keeps blank, so a later write there cannot split the glyph.
      if (isWide(char)) { columns[cursor] = { sgr, char: '' }; cursor++ }
    }
  }

  for (const match of line.matchAll(csi)) {
    consume(line.slice(at, match.index))
    at = match.index + match[0].length
    // Both groups are mandatory in the pattern, so destructuring types them as
    // strings without a fallback that could never run.
    const params = String(match[1])
    const final = String(match[2])
    if (final === 'K') {
      // Erase in line: the fixed companion of `\r` in every spinner and progress
      // bar. Without it a shorter redraw leaves the previous frame's tail
      // standing, which is text the terminal never showed. `1` blanks the
      // columns before the cursor rather than dropping them, since the cursor
      // does not move and a later write can still land past them.
      if (params === '1') for (let index = 0; index < cursor; index++) columns[index] = { sgr, char: ' ' }
      else columns.length = params === '2' ? 0 : cursor
      continue
    }
    // Only SGR carries graphic state; every other final byte is a cursor or
    // erase action that must not be accumulated into a cell's style.
    if (final !== 'm') continue
    sgr = /^0?$/.test(params) ? '' : sgr + match[0]
  }
  consume(line.slice(at))

  // Re-emit the columns, opening a run only where its SGR state changes, so
  // anser sees the same styling a terminal shows. A `\x1b[2K` can leave holes
  // before the cursor, which a terminal paints as blanks.
  let out = ''
  let active = entrySgr
  for (const slot of columns) {
    const column = slot ?? { sgr: '', char: ' ' }
    if (column.sgr !== active) {
      if (active !== '') out += '\u001b[0m'
      out += column.sgr
      active = column.sgr
    }
    out += column.char
  }
  // The state at the line's end continues onto the next line, so it is returned
  // rather than closed off with a reset here.
  return { text: out, sgr: active }
}

/**
 * Replay every line's cursor movements. A `\r` that only terminates a CRLF line
 * is dropped first, so those lines keep their text instead of being redrawn onto
 * themselves. SGR state threads across lines: a newline does not reset it, so a
 * run opened before a redraw still colors the lines after it.
 * @param text - output text, already free of OSC and non-CSI escapes.
 * @returns the text with each line painted as the terminal would.
 */
function applyCursorMovements(text: string): string {
  const replayed: string[] = []
  let sgr = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r+$/, '')
    // A line with no cursor movement or erase needs no replay — its tabs stay
    // literal for `white-space: pre` to lay out — but its own SGR still has to
    // be tracked so a later line that DOES replay enters with the right state.
    // Tabs only need column arithmetic where a redraw can land on them, which is
    // exactly the replayed case. An erase counts: `\x1b[1K` blanks columns even
    // with no `\r` beside it.
    const result = replayLine(line, sgr)
    replayed.push(/\r|\u0008|\u001b\[[0-9]*K/.test(line) ? result.text : line)
    sgr = result.sgr
  }
  return replayed.join('\n')
}

/**
 * Remove every escape sequence and control character that carries no color,
 * leaving CSI sequences for anser and `\n`/`\t` for layout. Cursor movements
 * (carriage return, backspace) replay first, since their effect on the visible
 * text must land before the characters that expressed them are dropped.
 * @param text - raw command output.
 * @returns text whose only remaining escapes are CSI sequences.
 */
function sanitize(text: string): string {
  const escaped = text.replace(OSC_SEQUENCE, '').replace(NON_CSI_ESCAPE, '')
  return applyCursorMovements(escaped).replace(INERT_CONTROL, '')
}

/**
 * Resolve one run's colors and decorations.
 * @param chunk - the anser chunk to style.
 * @returns the run's inline style, or undefined when it carries no SGR state.
 */
function resolveStyle(chunk: AnsiChunk): CSSProperties | undefined {
  const style: CSSProperties = {}
  const background = chunk.bg === null ? undefined : `rgb(${chunk.bg})`
  if (background !== undefined) style.backgroundColor = background
  if (chunk.fg !== null) {
    const literal = `rgb(${chunk.fg})`
    // A run that paints its own background keeps anser's literal pair so the
    // authored foreground/background contrast survives; a foreground-only run
    // maps onto a theme token, which adapts to light and dark surfaces.
    style.color = background === undefined
      ? TOKEN_BY_BASIC_RGB[chunk.fg.replace(/\s+/g, '')] ?? literal
      : literal
  }
  for (const decoration of chunk.decorations) Object.assign(style, STYLE_BY_DECORATION[decoration])
  return Object.keys(style).length === 0 ? undefined : style
}

/**
 * Parse command output into styled spans grouped by line.
 * @param text - raw output text, which may contain ANSI escape sequences.
 * @returns one entry per output line (always at least one, possibly empty).
 */
export function parseAnsiLines(text: string): AnsiLine[] {
  let current: AnsiSpan[] = []
  const lines: AnsiSpan[][] = [current]
  for (const chunk of Anser.ansiToJson(sanitize(text), { json: true, remove_empty: true })) {
    const style = resolveStyle(chunk)
    for (const [index, part] of chunk.content.split('\n').entries()) {
      if (index > 0) {
        current = []
        lines.push(current)
      }
      if (part !== '') current.push({ text: part, style })
    }
  }
  return lines
}
