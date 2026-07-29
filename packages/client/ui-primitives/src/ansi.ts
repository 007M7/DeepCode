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
 * survive: the first two for layout, backspace for its overwrite, ESC for
 * anser's CSI split.
 */
const INERT_CONTROL = /[\u0000-\u0007\u000b-\u001a\u001c-\u001f\u007f]/g

/**
 * Apply carriage-return redraws: within a line, only the text after the last
 * `\r` survives, which is what a terminal shows for progress output. A `\r`
 * that only terminates a CRLF line is dropped first so those lines keep
 * their text. SGR codes preceding a dropped redraw are dropped with it.
 * @param text - output text, already free of OSC and non-CSI escapes.
 * @returns the text with each line reduced to its final redraw.
 */
function applyCarriageReturns(text: string): string {
  return text.split('\n').map((raw) => {
    const line = raw.replace(/\r+$/, '')
    return line.slice(line.lastIndexOf('\r') + 1)
  }).join('\n')
}

/**
 * Apply backspaces as the cursor-left-then-overwrite a terminal performs, so
 * `abc` followed by two backspaces and `XY` reads `aXY` instead of keeping the
 * characters it overwrote. Progress meters and captured PTY output use
 * backspace this way. Resolved per line, so a backspace neither eats the
 * newline before it nor reaches into the previous line's tail; one at a line
 * start has nothing to erase.
 * @param text - output text, already reduced to its carriage-return redraws.
 * @returns the text with each backspace resolved against the character before it.
 */
function applyBackspaces(text: string): string {
  if (!text.includes('\u0008')) return text
  return text.split('\n').map(applyBackspacesToLine).join('\n')
}

/**
 * One line's backspaces, resolved over VISIBLE characters only. A CSI sequence
 * moves no cursor, so it must survive intact: erasing its bytes would corrupt
 * the sequence and repaint the rest of the output with whatever the mangled
 * remainder parses as. The sequences are therefore held as indivisible units
 * that a backspace steps over on its way to the last printed character, and a
 * unit already erased stays erased so a run's own color still applies to what
 * remains of it.
 * @param line - one output line, still carrying its CSI sequences.
 * @returns the line with each backspace applied to the character before it.
 */
function applyBackspacesToLine(line: string): string {
  if (!line.includes('\u0008')) return line
  const units: { text: string; visible: boolean }[] = []
  // Same shape anser splits on: CSI ... final byte. Matched here so a sequence
  // is one unit rather than a run of erasable characters.
  const csi = /\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]/g
  let at = 0
  for (const match of line.matchAll(csi)) {
    for (const char of line.slice(at, match.index)) units.push({ text: char, visible: true })
    units.push({ text: match[0], visible: false })
    at = match.index + match[0].length
  }
  for (const char of line.slice(at)) units.push({ text: char, visible: true })

  const kept: { text: string; visible: boolean }[] = []
  for (const unit of units) {
    if (unit.visible && unit.text === '\u0008') {
      // Walk back past any escapes to the last printed character and drop it,
      // keeping those escapes so the surviving text stays styled as authored.
      for (let index = kept.length - 1; index >= 0; index--) {
        if (kept[index]?.visible !== true) continue
        kept.splice(index, 1)
        break
      }
      continue
    }
    kept.push(unit)
  }
  return kept.map(unit => unit.text).join('')
}

/**
 * Remove every escape sequence and control character that carries no color,
 * leaving CSI sequences for anser and `\n`/`\t` for layout. Carriage-return
 * redraws and backspace overwrites resolve first: both are cursor movements
 * whose effect on the visible text must land before the characters that
 * expressed them are dropped.
 * @param text - raw command output.
 * @returns text whose only remaining escapes are CSI sequences.
 */
function sanitize(text: string): string {
  const escaped = text.replace(OSC_SEQUENCE, '').replace(NON_CSI_ESCAPE, '')
  return applyBackspaces(applyCarriageReturns(escaped)).replace(INERT_CONTROL, '')
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
