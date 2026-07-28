/**
 * Pure listing presentation: order one directory's direct children so a capped
 * view still shows the navigable structure, and render the model-facing
 * envelope. Cordis-free and independently unit-tested, mirroring
 * {@link module:@deepseek-ai/dsh-tool-fs/read-render}.
 * @module @deepseek-ai/dsh-tool-fs/list-render
 */

/** Default and maximum number of entries one `list` call renders inline (the `listMaxEntries` config). */
export const LIST_MAX_ENTRIES = 200

/** One direct child in a rendered listing — the canonical entry shape the tool returns. */
export interface ListedEntry {
  /** Basename of the child inside the listed directory. */
  name: string
  /** Whether the child is a regular file, a directory, or something else (symlink, socket, device). */
  type: 'file' | 'directory' | 'other'
}

/**
 * Order direct children so truncation cannot hide the directory tree:
 * directories first, then files, then everything else, each group by name.
 *
 * The provider seam returns children in stable name order, which puts a
 * subdirectory wherever the alphabet puts it; capping such a list can drop every
 * subdirectory and leave the model believing a directory holds only files. This
 * is the listing counterpart of the `glob` coverage footer.
 *
 * @param entries - the seam's direct children, in any order.
 * @returns a new array in directory-first display order; the input is not mutated.
 */
export function orderEntries<T extends ListedEntry>(entries: readonly T[]): T[] {
  const rank = { directory: 0, file: 1, other: 2 }
  return [...entries].sort((a, b) => rank[a.type] - rank[b.type] || a.name.localeCompare(b.name))
}

/** `1 directory` / `4 directories` — a count the model reads as prose, not as `1 directorie(s)`. */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** The `<d> directories, <f> files[, <o> other]` breakdown; the `other` clause appears only when non-empty. */
function breakdown(entries: readonly ListedEntry[]): string {
  const directories = entries.filter(entry => entry.type === 'directory').length
  const other = entries.filter(entry => entry.type === 'other').length
  const files = entries.length - directories - other
  const parts = [count(directories, 'directory', 'directories'), count(files, 'file', 'files')]
  if (other > 0) parts.push(`${other} other`)
  return parts.join(', ')
}

/**
 * Render the model-facing `list` result: the displayed entries, then a footer
 * that always states the COMPLETE listing's size and composition, so a capped
 * view can never read as the whole directory.
 *
 * Directories carry a trailing `/` and non-regular children a trailing `@`, so
 * the model can tell what it may descend into without a second call.
 *
 * @param displayPath - the resolved directory as the backend displays it.
 * @param entries - the complete listing, already in {@link orderEntries} order.
 * @param maxEntries - how many entries to show inline; the rest are summarized by the footer.
 * @returns the model-facing text.
 */
export function formatListOutput(displayPath: string, entries: readonly ListedEntry[], maxEntries: number): string {
  const shown = entries.slice(0, maxEntries)
  const suffix = { directory: '/', file: '', other: '@' }
  const footer = shown.length < entries.length
    ? `(Showing ${shown.length} of ${count(entries.length, 'entry', 'entries')}: ${breakdown(entries)}. `
      + 'Entries are directories first, then files, each alphabetical; list a subdirectory to see the rest.)'
    : entries.length === 0
      ? '(Empty directory)'
      : `(${count(entries.length, 'entry', 'entries')}: ${breakdown(entries)})`
  const body = shown.length > 0
    ? `${shown.map(entry => `${entry.name}${suffix[entry.type]}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>directory</type>
<content>
${body}
</content>`
}
