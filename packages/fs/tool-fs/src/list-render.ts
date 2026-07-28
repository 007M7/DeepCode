/**
 * Pure directory-listing presentation: order direct children, count complete
 * composition, and render a bounded page without allowing filesystem text to
 * forge the result envelope.
 * @module @deepseek-ai/dsh-tool-fs/list-render
 */

/** Default and maximum number of entries one `list` call returns (the `listMaxEntries` config). */
export const LIST_MAX_ENTRIES = 200

/** One direct child in a directory listing. */
export interface ListedEntry {
  /** Basename of the child inside the listed directory. */
  name: string
  /** Whether the child is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
}

/** Complete-listing composition retained on every page. */
export interface ListCounts {
  directories: number
  files: number
  other: number
}

/** Canonical bounded result returned by one `list` call. */
export interface ListPage {
  /** Backend display path of the listed directory. */
  path: string
  /** 1-based index of the first returned entry. */
  offset: number
  /** Current page in directory-first, name-sorted order. */
  entries: ListedEntry[]
  /** Number of direct children in the complete listing. */
  totalEntries: number
  /** Composition of the complete listing, not only this page. */
  counts: ListCounts
}

/**
 * Sort directories before files before other entries, each group by name.
 * @param entries - direct children in provider order.
 * @returns a new directory-first array without mutating `entries`.
 */
export function orderEntries<T extends ListedEntry>(entries: readonly T[]): T[] {
  const rank = { directory: 0, file: 1, other: 2 }
  return [...entries].sort((a, b) => rank[a.type] - rank[b.type] || a.name.localeCompare(b.name))
}

/**
 * Count every entry type in a complete listing.
 * @param entries - every direct child in the listed directory.
 * @returns the complete directory/file/other composition.
 */
export function countEntries(entries: readonly ListedEntry[]): ListCounts {
  const counts: ListCounts = { directories: 0, files: 0, other: 0 }
  for (const entry of entries) {
    if (entry.type === 'directory') counts.directories += 1
    else if (entry.type === 'file') counts.files += 1
    else counts.other += 1
  }
  return counts
}

/** `1 directory` / `4 directories`. */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** Complete-listing composition as model-facing prose. */
function breakdown(counts: ListCounts): string {
  const parts = [
    count(counts.directories, 'directory', 'directories'),
    count(counts.files, 'file', 'files'),
  ]
  if (counts.other > 0) parts.push(`${counts.other} other`)
  return parts.join(', ')
}

/** JSON-string encode untrusted filesystem text and neutralize envelope tags. */
function encodeFilesystemText(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

/**
 * Render one bounded listing page. Entry names are JSON strings followed by `/`
 * for directories or `@` for non-regular children; regular files have no suffix.
 * The footer carries complete composition and an exact continuation offset.
 *
 * @param page - the canonical listing page.
 * @returns the model-facing directory envelope.
 */
export function formatListOutput(page: ListPage): string {
  const suffix = { directory: '/', file: '', other: '@' }
  const end = page.entries.length === 0 ? 0 : page.offset + page.entries.length - 1
  const footer = page.totalEntries === 0
    ? '(Empty directory)'
    : page.offset > 1 || page.entries.length < page.totalEntries
      ? `(Showing entries ${page.offset}-${end} of ${page.totalEntries}: ${breakdown(page.counts)}.`
        + (end < page.totalEntries ? ` Use offset=${end + 1} to continue.)` : ')')
      : `(${count(page.totalEntries, 'entry', 'entries')}: ${breakdown(page.counts)})`
  const body = page.entries.length > 0
    ? `${page.entries.map(entry => `${encodeFilesystemText(entry.name)}${suffix[entry.type]}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${encodeFilesystemText(page.path)}</path>
<type>directory</type>
<content>
${body}
</content>`
}
