// parseAnsiLines, the ANSI model behind TerminalBlock: anser's SGR runs
// resolved into inline styles and folded into per-line span arrays, with every
// escape and control character that carries no color removed first. The DOM
// side of the same model (which runs get a span wrapper) is in
// terminal-block.spec.tsx.

import { describe, expect, it } from 'vitest'
import { parseAnsiLines } from '../src/ansi.ts'

const ESC = '\u001b'
const BS = '\u0008'

/** Paint `text` with the SGR `codes`, then reset. */
function sgr(codes: string, text: string): string {
  return `${ESC}[${codes}m${text}${ESC}[0m`
}

/** The single span of a single-line, single-run parse. */
function onlySpan(text: string) {
  const lines = parseAnsiLines(text)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toHaveLength(1)
  return lines[0]![0]!
}

describe('parseAnsiLines: text without SGR state', () => {
  it('leaves plain text as one unstyled span', () => {
    expect(parseAnsiLines('hello')).toEqual([[{ text: 'hello', style: undefined }]])
  })

  it('returns exactly one empty line for empty input', () => {
    expect(parseAnsiLines('')).toEqual([[]])
  })

  it('splits a multi-line run and drops the empty line between two blocks', () => {
    expect(parseAnsiLines('a\n\nb')).toEqual([
      [{ text: 'a', style: undefined }],
      [],
      [{ text: 'b', style: undefined }],
    ])
  })

  it('keeps tabs, which the terminal surface needs for column layout', () => {
    expect(onlySpan('a\tb')).toEqual({ text: 'a\tb', style: undefined })
  })
})

describe('parseAnsiLines: basic colors mapped onto theme tokens', () => {
  it.each<[string, string, string]>([
    ['30', 'black', 'var(--dsw-alias-label-primary)'],
    ['37', 'white', 'var(--dsw-alias-label-primary)'],
    ['90', 'bright black', 'var(--dsw-alias-label-tertiary)'],
    ['31', 'red', 'var(--dsw-alias-state-error-primary)'],
    ['91', 'bright red', 'var(--dsw-alias-state-error-secondary)'],
    ['32', 'green', 'var(--dsw-alias-state-success-primary)'],
    ['92', 'bright green', 'var(--dsw-alias-state-success-secondary)'],
    ['33', 'yellow', 'var(--dsw-alias-state-warn-primary)'],
    ['93', 'bright yellow', 'var(--dsw-alias-state-warn-secondary)'],
    ['34', 'blue', 'var(--dsw-alias-state-business-primary)'],
    ['94', 'bright blue', 'var(--dsw-static-blue-400)'],
  ])('SGR %s (%s) resolves to %s', (code, _name, token) => {
    expect(onlySpan(sgr(code, 'x'))).toEqual({ text: 'x', style: { color: token } })
  })
})

describe('parseAnsiLines: colors with no token equivalent', () => {
  it.each<[string, string, string]>([
    ['35', 'magenta', 'rgb(187, 0, 187)'],
    ['36', 'cyan', 'rgb(0, 187, 187)'],
    ['38;5;208', '256-palette orange', 'rgb(255, 135, 0)'],
    ['38;2;10;20;30', 'truecolor', 'rgb(10, 20, 30)'],
  ])('SGR %s (%s) falls through to %s', (code, _name, literal) => {
    expect(onlySpan(sgr(code, 'x')).style).toEqual({ color: literal })
  })
})

describe('parseAnsiLines: backgrounds', () => {
  it('sets backgroundColor for a background-only run', () => {
    expect(onlySpan(sgr('44', 'x')).style).toEqual({ backgroundColor: 'rgb(0, 0, 187)' })
  })

  it('keeps the literal foreground when the run paints its own background', () => {
    expect(onlySpan(sgr('41;37', 'x')).style).toEqual({
      backgroundColor: 'rgb(187, 0, 0)',
      color: 'rgb(255,255,255)',
    })
  })

  it('renders reverse video as the swapped pair anser reports', () => {
    expect(onlySpan(sgr('31;7', 'x')).style).toEqual({
      backgroundColor: 'rgb(187, 0, 0)',
      color: 'rgb(0, 0, 0)',
    })
  })
})

describe('parseAnsiLines: decorations', () => {
  it.each<[string, string, Record<string, unknown>]>([
    ['1', 'bold', { fontWeight: 700 }],
    ['2', 'dim', { opacity: 0.7 }],
    ['3', 'italic', { fontStyle: 'italic' }],
    ['4', 'underline', { textDecoration: 'underline' }],
    ['9', 'strikethrough', { textDecoration: 'line-through' }],
    ['8', 'hidden', { visibility: 'hidden' }],
  ])('SGR %s (%s) resolves to %o', (code, _name, style) => {
    expect(onlySpan(sgr(code, 'x')).style).toEqual(style)
  })

  it('lets the later textDecoration win when a run declares underline and strikethrough', () => {
    expect(onlySpan(sgr('4;9', 'x')).style).toEqual({ textDecoration: 'line-through' })
    expect(onlySpan(sgr('9;4', 'x')).style).toEqual({ textDecoration: 'underline' })
  })

  it('combines a color with several decorations in one style', () => {
    expect(onlySpan(sgr('1;3;31', 'x')).style).toEqual({
      color: 'var(--dsw-alias-state-error-primary)',
      fontWeight: 700,
      fontStyle: 'italic',
    })
  })

  it('reproduces no animation for blink, leaving the run unstyled', () => {
    expect(onlySpan(sgr('5', 'x'))).toEqual({ text: 'x', style: undefined })
  })
})

describe('parseAnsiLines: sequences that carry no color', () => {
  it('removes an OSC string with its BEL terminator', () => {
    expect(onlySpan(`a${ESC}]0;window title\u0007b`)).toEqual({ text: 'ab', style: undefined })
  })

  it('removes an OSC string terminated by ST', () => {
    expect(onlySpan(`a${ESC}]8;;https://example.com${ESC}\\b`)).toEqual({ text: 'ab', style: undefined })
  })

  it('removes non-CSI escapes such as charset selection and reset', () => {
    expect(onlySpan(`x${ESC}(By${ESC}cz`)).toEqual({ text: 'xyz', style: undefined })
  })

  it('removes inert C0 controls', () => {
    expect(onlySpan('\u0000ab\u001fc\u007f')).toEqual({ text: 'abc', style: undefined })
  })

  it('keeps CSI sequences that only move the cursor out of the text', () => {
    expect(onlySpan(`${ESC}[2K${ESC}[1Adone`)).toEqual({ text: 'done', style: undefined })
  })
})

describe('parseAnsiLines: carriage returns', () => {
  it('keeps only the last redraw of a line', () => {
    expect(onlySpan('10%\r55%\r100%')).toEqual({ text: '100%', style: undefined })
  })

  it('drops the SGR codes that preceded a discarded redraw', () => {
    expect(onlySpan(`${ESC}[31mgone\rkept`)).toEqual({ text: 'kept', style: undefined })
  })

  it('preserves both lines of a CRLF pair instead of treating it as a redraw', () => {
    expect(parseAnsiLines('a\r\r\nb\r\n')).toEqual([
      [{ text: 'a', style: undefined }],
      [{ text: 'b', style: undefined }],
      [],
    ])
  })

  it('applies the redraw per line, not across the whole text', () => {
    expect(parseAnsiLines('one\rtwo\nthree')).toEqual([
      [{ text: 'two', style: undefined }],
      [{ text: 'three', style: undefined }],
    ])
  })
})

describe('parseAnsiLines: backspaces', () => {
  it('applies a backspace as the overwrite a terminal draws', () => {
    // `abc` then two backspaces then `XY` shows as `aXY`, not `abcXY`.
    expect(onlySpan(`abc${BS}${BS}XY`)).toEqual({ text: 'aXY', style: undefined })
  })

  it('stops at the line start instead of eating the newline before it', () => {
    expect(parseAnsiLines(`ab\n${BS}${BS}${BS}cd`)).toEqual([
      [{ text: 'ab', style: undefined }],
      [{ text: 'cd', style: undefined }],
    ])
  })

  it('steps over an SGR sequence instead of erasing its bytes', () => {
    // `abc` reset then two backspaces then `XY`: erasing the reset's bytes would
    // corrupt it and repaint the rest of the line with whatever the remainder
    // parses as. The visible result is `aXY`, still red, with the reset intact.
    expect(parseAnsiLines(`${sgr('31', 'abc')}${BS}${BS}XY`)).toEqual([[
      { text: 'a', style: { color: 'var(--dsw-alias-state-error-primary)' } },
      { text: 'XY', style: undefined },
    ]])
  })

  it('erases across a style boundary without dropping the styles between', () => {
    // The backspace reaches back past the reset to the last printed character.
    expect(parseAnsiLines(`${sgr('32', 'ok')}${ESC}[31m${BS}bad`)).toEqual([[
      { text: 'o', style: { color: 'var(--dsw-alias-state-success-primary)' } },
      { text: 'bad', style: { color: 'var(--dsw-alias-state-error-primary)' } },
    ]])
  })

  it('applies the overwrite after a carriage-return redraw, not before', () => {
    // The redraw wins first; the backspace then erases inside what survived.
    expect(onlySpan(`old\rnew${BS}`)).toEqual({ text: 'ne', style: undefined })
  })

  it('keeps the run\'s style while erasing its own characters', () => {
    expect(onlySpan(sgr('31', `bad${BS}${BS}${BS}ok`)))
      .toEqual({ text: 'ok', style: { color: 'var(--dsw-alias-state-error-primary)' } })
  })
})

describe('parseAnsiLines: runs spanning lines', () => {
  it('carries one run\'s style onto every line it covers', () => {
    expect(parseAnsiLines(sgr('32', 'first\nsecond'))).toEqual([
      [{ text: 'first', style: { color: 'var(--dsw-alias-state-success-primary)' } }],
      [{ text: 'second', style: { color: 'var(--dsw-alias-state-success-primary)' } }],
    ])
  })

  it('keeps several runs of one line in order', () => {
    expect(parseAnsiLines(`plain${sgr('31', 'red')}tail`)).toEqual([[
      { text: 'plain', style: undefined },
      { text: 'red', style: { color: 'var(--dsw-alias-state-error-primary)' } },
      { text: 'tail', style: undefined },
    ]])
  })
})
