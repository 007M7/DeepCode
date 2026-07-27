/**
 * Theme-agnostic ANSI palette and derived pi-tui themes for the terminal front
 * door. The palette is built from the standard 16-color ANSI set plus SGR
 * attributes so every terminal remaps it to its active color scheme.
 * @module @deepseek-ai/dsh-tui/components/theme
 */

import type {
  MarkdownTheme,
  SelectListTheme,
  TerminalColorScheme,
} from '@earendil-works/pi-tui'

/** Theme-agnostic role colors and SGR attribute wrappers. */
export interface Palette {
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

/**
 * Theme-agnostic palette built from the standard 16-color ANSI set plus SGR
 * attributes, which every terminal remaps to its active color scheme. Body
 * `text` stays the terminal's default foreground so it reads on light and dark
 * backgrounds alike; grouping uses foreground-only bold, underlined role
 * headers and reverse video rather than fixed background fills or per-line
 * prefixes, so a transcript drag-select copies message text without stray
 * glyphs.
 *
 * @param enabled - Whether ANSI is emitted at all.
 * @param scheme - Active terminal color scheme; adjusts dim and code roles.
 * @returns The role palette for the given scheme.
 */
export function createPalette(enabled: boolean, scheme: TerminalColorScheme = 'dark'): Palette {
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
export function gradientText(text: string): string {
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

/**
 * Derive the pi-tui Markdown theme from a role palette.
 * @param palette - Active role palette.
 * @returns The Markdown theme wired to palette roles.
 */
export function markdownTheme(palette: Palette): MarkdownTheme {
  return {
    heading: text => palette.accent(text),
    link: text => palette.accent(text),
    // pi-tui requires this URL slot but its current Markdown renderer does not invoke it.
    /* v8 ignore next */
    linkUrl: text => palette.dim(text),
    code: text => palette.code(text),
    codeBlock: text => palette.code(text),
    // pi-tui presents both fence rows through this callback. Keep the opening
    // language label, but hide Markdown syntax and the otherwise-empty close.
    codeBlockBorder: text => palette.dim(text.slice(3)),
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

/**
 * Derive the pi-tui select-list theme from a role palette.
 * @param palette - Active role palette.
 * @returns The select-list theme wired to palette roles.
 */
export function selectTheme(palette: Palette): SelectListTheme {
  return {
    selectedPrefix: palette.accent,
    selectedText: palette.accent,
    description: palette.muted,
    scrollInfo: palette.dim,
    noMatch: palette.warning,
  }
}

/**
 * Derive the reverse-video dialog select-list theme from a role palette.
 * @param palette - Active role palette.
 * @returns The dialog select-list theme with a reverse-video selection.
 */
export function dialogSelectTheme(palette: Palette): SelectListTheme {
  return {
    ...selectTheme(palette),
    selectedText: text => palette.selected(palette.accent(text)),
  }
}
