/**
 * Result-time contextual-diff computation for the `write`/`edit` tools. Turns a
 * before/after pair of file texts into one {@link FileDiff} per applied hunk —
 * each hunk's `oldText`/`newText` reconstructed from the unified-diff lines with
 * ±{@link DIFF_CONTEXT} surrounding context lines, matching how claude-agent-acp
 * renders an editor inline diff.
 *
 * This is display-only presentation vocabulary (a UI concern), so it lives in
 * the model-facing tool, NOT the `dsh-fs` storage seam — the backend returns
 * only the raw before/after text (storage facts) and the tool computes the diff.
 *
 * @module @deepseek-ai/dsh-tool-fs/src/diff
 */

import { structuredPatch } from 'diff'
import type { FileDiff } from '@deepseek-ai/dsh-tools'

/** Context lines shown on each side of an applied hunk (matches claude-agent-acp). */
export const DIFF_CONTEXT = 3

/**
 * The `write`/`edit` tools' private `tool/result` `meta` payload: the applied
 * contextual-diff hunks. Attached opaquely (as `unknown`) on the tool result and
 * persisted with the session log — it must be JSON-serializable (the session
 * validates this at `append`), so `presentResult` reproduces the diff card on
 * replay. The producing tool owns this shape; the bridge only sees the opaque
 * `meta` and the tool narrows it back via {@link diffsFromMeta}.
 */
export type FsDiffMeta = { diffs: FileDiff[] }

/**
 * Compute one {@link FileDiff} per hunk between `before` and `after`, each
 * carrying the applied change plus {@link DIFF_CONTEXT} context lines. Returns an
 * empty array when the texts are identical (no hunks). For a scattered
 * `replace_all` edit the patch yields multiple hunks, so multiple `FileDiff`s
 * come back — matching the editor rendering one diff block per site.
 *
 * Each hunk's `oldText` is its `-` (removed) and context lines joined by `\n`;
 * `newText` is its `+` (added) and context lines. A hunk with no old lines
 * (a pure insertion) reports `oldText: null` (nothing to diff against), mirroring
 * the call-time card's new-file convention. The unified-diff "\ No newline at end
 * of file" markers are dropped — they annotate the patch, not file content.
 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: DIFF_CONTEXT })
  const diffs: FileDiff[] = []
  for (const hunk of patch.hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk.lines) {
      // The unified-diff marker for a missing trailing newline annotates the
      // patch, not the content — skip it so it never leaks into a diff block.
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) {
        oldLines.push(text)
      } else if (line.startsWith('+')) {
        newLines.push(text)
      } else {
        // A context (unchanged) line appears on both sides.
        oldLines.push(text)
        newLines.push(text)
      }
    }
    diffs.push({ path, oldText: oldLines.length > 0 ? oldLines.join('\n') : null, newText: newLines.join('\n') })
  }
  return diffs
}

/** Whether `value` is a valid {@link FileDiff} (defensive narrowing from opaque `meta`). */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/**
 * Narrow an opaque `tool/result` `meta` back to this tool's {@link FileDiff}
 * hunks, or `undefined` when it is absent/malformed. `presentResult` runs on
 * arbitrary logged `meta` (possibly from an older shape or a hand-edited log), so
 * it validates defensively rather than trusting the payload — a bad `meta` yields
 * `undefined`, and the caller decides the fallback (edit → the generic result
 * rendering; write → an args-derived whole-file diff), never a thrown presenter.
 */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

