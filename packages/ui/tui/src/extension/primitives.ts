/**
 * Terminal-safe primitives for components mounted through the TUI extension service.
 *
 * Extensions use these wrappers instead of importing the underlying renderer, so
 * `ctx.tui` remains the owner of key decoding, ANSI wrapping, and column width.
 * @module @deepseek-ai/dsh-tui/extension-primitives
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type KeyId,
} from '@earendil-works/pi-tui'

/** Key identifiers accepted by TUI extension components. */
export const TuiKey = Key

/**
 * Test whether terminal input matches one semantic key.
 * @param data - Raw terminal input delivered to the component.
 * @param key - Semantic key identifier to match.
 * @returns Whether the input encodes the requested key.
 */
export function matchesTuiKey(data: string, key: KeyId): boolean {
  return matchesKey(data, key)
}

/**
 * Measure terminal columns after ignoring ANSI control sequences.
 * @param value - Styled or plain terminal text.
 * @returns Visible terminal-column width.
 */
export function tuiVisibleWidth(value: string): number {
  return visibleWidth(value)
}

/**
 * Wrap styled terminal text without splitting ANSI sequences.
 * @param value - Styled or plain terminal text.
 * @param width - Maximum visible columns per line.
 * @returns Wrapped lines preserving active ANSI styling.
 */
export function wrapTuiText(value: string, width: number): string[] {
  return wrapTextWithAnsi(value, width)
}

/**
 * Truncate styled terminal text to a visible-column limit.
 * @param value - Styled or plain terminal text.
 * @param width - Maximum visible columns.
 * @param ellipsis - Suffix used when truncation occurs.
 * @returns Text whose visible width does not exceed the limit.
 */
export function truncateTuiText(value: string, width: number, ellipsis = ''): string {
  return truncateToWidth(value, width, ellipsis)
}
