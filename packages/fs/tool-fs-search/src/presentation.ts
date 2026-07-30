/**
 * Result-time search-card presentation for `grep` and `glob`. Both tools land on
 * one `card: 'search'` render intent ({@link SearchResultView}) with two
 * `kind`-discriminated shapes: `grep` projects its matches grouped by file
 * ({@link SearchMatchesResultView}), `glob` projects a flat path list
 * ({@link SearchPathsResultView}). This module owns the value→`presentationMeta`
 * projection each tool declares and the defensive `meta`→view narrowing each
 * tool's `presentResult` reads back on replay.
 *
 * The canonical value never crosses the wire — only the model-facing render text
 * and this JSON `meta` do — so the structured shape a UI renders MUST ride in
 * `meta`. Each projection applies the SAME inline cap the model-facing render
 * applies ({@link module:@deepseek-ai/dsh-tool-fs-search/grep} `grepMaxMatches`,
 * {@link module:@deepseek-ai/dsh-tool-fs-search/glob} `globMaxResults`) and reports
 * `total` (every result found) and `truncated`, so a UI never presents a capped
 * result as complete.
 *
 * @module @deepseek-ai/dsh-tool-fs-search/presentation
 */

import type {
  SearchFileMatches,
  SearchLineMatch,
  SearchResultView,
} from '@deepseek-ai/dsh-tools'
import { ItemRetainer } from '@deepseek-ai/dsh-retention'
import type { GrepMatch } from './grep.ts'
import { previewLine } from './grep.ts'

/**
 * The `grep`/`glob` tools' private `tool/result` `meta` payload: the capped,
 * structured search result. Attached opaquely (as `JsonValue`) on the tool result
 * and persisted with the session log, so `presentResult` reproduces the search
 * card on replay. The `matches` shape carries the by-file groups; the `paths`
 * shape carries the flat list. Both carry the pre-cap `total` and the `truncated`
 * flag. The producing tool owns and narrows this opaque shape.
 *
 * The member shapes use object-literal `type` aliases rather than the
 * {@link SearchFileMatches}/{@link SearchLineMatch} interfaces because only a type
 * alias is assignable to the `JsonValue` index signature `presentationMeta`
 * returns; the two are structurally identical, so the projected value still reads
 * back as a {@link SearchResultView}.
 */
export type SearchMeta =
  | { kind: 'matches'; files: MetaFileMatches[]; truncated: boolean; total: number }
  | { kind: 'paths'; paths: string[]; truncated: boolean; total: number }

/** One matched line in {@link SearchMeta} (the JSON-assignable form of {@link SearchLineMatch}). */
type MetaLineMatch = { lineNumber: number; line: string }

/** One file's grouped matches in {@link SearchMeta} (the JSON-assignable form of {@link SearchFileMatches}). */
type MetaFileMatches = { path: string; matches: MetaLineMatch[] }

/**
 * Group flat matches by file (first-seen order) into the structured by-file shape
 * a UI renders as expandable per-file groups. The grouping matches the
 * model-facing text grouping
 * ({@link module:@deepseek-ai/dsh-tool-fs-search/grep} `formatGrepMatches`), so
 * card and text agree about file order and membership.
 *
 * @param matches - the retained matches to group, in output order.
 * @returns one entry per file, in first-seen order.
 */
export function groupMatchesByFile(matches: GrepMatch[]): MetaFileMatches[] {
  const byFile = new Map<string, MetaLineMatch[]>()
  for (const match of matches) {
    const entry: MetaLineMatch = { lineNumber: match.lineNumber, line: match.line }
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(entry)
    else byFile.set(match.path, [entry])
  }
  return Array.from(byFile, ([path, fileMatches]) => ({ path, matches: fileMatches }))
}

/**
 * Project the canonical `grep` matches into {@link SearchMeta} for the search
 * card. Applies the per-line preview budget and the inline match cap exactly as
 * the model-facing render does, groups the retained matches by file, and reports
 * `total` (every parsed match) and `truncated`.
 *
 * @param matches - every match the search parsed (the canonical value's matches).
 * @param maxMatches - the inline match cap (the `grepMaxMatches` config).
 * @param maxLineBytes - the per-matched-line preview budget in bytes.
 * @returns the `matches`-shaped search metadata.
 */
export function grepSearchMeta(matches: GrepMatch[], maxMatches: number, maxLineBytes: number): SearchMeta {
  const retainer = new ItemRetainer<GrepMatch>({ kind: 'head', maxItems: maxMatches })
  for (const match of matches) retainer.push({ ...match, line: previewLine(match.line, maxLineBytes) })
  const retained = retainer.finish()
  return { kind: 'matches', files: groupMatchesByFile(retained.items), truncated: retained.truncated, total: retained.seen }
}

/**
 * Project the canonical `glob` paths into {@link SearchMeta} for the search card.
 * Applies the inline path cap exactly as the model-facing render does and reports
 * `total` (every discovered path) and `truncated`.
 *
 * @param paths - every path the search discovered (the canonical value's paths).
 * @param maxResults - the inline path cap (the `globMaxResults` config).
 * @returns the `paths`-shaped search metadata.
 */
export function globSearchMeta(paths: string[], maxResults: number): SearchMeta {
  const retainer = new ItemRetainer<string>({ kind: 'head', maxItems: maxResults })
  for (const path of paths) retainer.push(path)
  const retained = retainer.finish()
  return { kind: 'paths', paths: retained.items, truncated: retained.truncated, total: retained.seen }
}

/** Whether `value` is a valid {@link SearchLineMatch} (defensive narrowing from opaque `meta`). */
function isSearchLineMatch(value: unknown): value is SearchLineMatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { lineNumber, line } = value as Record<string, unknown>
  return typeof lineNumber === 'number' && typeof line === 'string'
}

/** Whether `value` is a valid {@link SearchFileMatches} (defensive narrowing from opaque `meta`). */
function isSearchFileMatches(value: unknown): value is SearchFileMatches {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, matches } = value as Record<string, unknown>
  return typeof path === 'string' && Array.isArray(matches) && matches.every(isSearchLineMatch)
}

/**
 * Narrow opaque live or replayed result metadata to a {@link SearchResultView}.
 * Malformed metadata returns `undefined` so `presentResult` can fall back to the
 * generic card instead of throwing during replay of an older or hand-edited log.
 * The returned view carries no `content`; the caller attaches the model-facing
 * result text so a UI without a search card renders it as text.
 *
 * @param meta - result metadata (the {@link SearchMeta} the tool projected).
 * @returns the search view, or `undefined` for absent or malformed metadata.
 */
export function searchViewFromMeta(meta: unknown): SearchResultView | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const { truncated, total } = record
  if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
  if (record.kind === 'matches') {
    const { files } = record
    if (!Array.isArray(files) || !files.every(isSearchFileMatches)) return undefined
    return { card: 'search', kind: 'matches', files: files, truncated, total }
  }
  if (record.kind === 'paths') {
    const { paths } = record
    if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) return undefined
    return { card: 'search', kind: 'paths', paths, truncated, total }
  }
  return undefined
}
