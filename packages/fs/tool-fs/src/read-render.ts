/**
 * Pure read presentation: turn provider-decoded text into a bounded, line-numbered window and
 * model-facing envelope. Chunk scanning caps the current line, so even one newline-free giant
 * line cannot grow memory without bound.
 * @module @deepseek-ai/dsh-tool-fs/read-render
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** Default maximum characters returned for a single line (the `readMaxLineLength` config). */
export const READ_MAX_LINE_LENGTH = 2000

/** Default maximum bytes returned for selected file lines (the `readMaxBytes` config). */
export const READ_MAX_BYTES = 50 * 1024

/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface ReadWindow {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines to return. */
  limit: number
  /** Maximum characters returned for a single line; overflow is truncated with a suffix. */
  maxLineLength: number
  /** Maximum bytes of selected output; overflow stops the scan and marks `truncatedByBytes`. */
  maxBytes: number
}

/** One line returned from a text file. */
export interface FileTextLine {
  /** 1-based line number in the file. */
  number: number
  /** Line text without its trailing newline. */
  text: string
}

/** The windowed result {@link buildWindow} produces from a file's decoded text. */
export interface WindowResult {
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Total line count in the file, unless `truncatedByBytes` stopped scanning early. */
  totalLines: number
  /** Whether selected output hit the byte cap before EOF or the requested limit. */
  truncatedByBytes: boolean
}

/** Outcome of a bounded text read — what {@link formatReadOutput} renders. */
export interface FileReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Total line count in the file, unless `truncatedByBytes` stopped scanning early. */
  totalLines: number
  /** Whether selected output hit the byte cap before EOF or the requested limit. */
  truncatedByBytes?: true
}

interface WindowAccumulator {
  lines: FileTextLine[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
  done: boolean
}

function newAccumulator(): WindowAccumulator {
  return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false, done: false }
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line
}

function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function consumeLine(acc: WindowAccumulator, rawLine: string, request: ReadWindow): void {
  acc.totalLines += 1
  if (acc.totalLines < request.offset || acc.lines.length >= request.limit) return

  const text = truncateLine(rawLine, request.maxLineLength)
  const bytes = lineByteSize(text, acc.lines.length)
  if (acc.outputBytes + bytes > request.maxBytes) {
    acc.truncatedByBytes = true
    acc.done = true
    return
  }
  acc.outputBytes += bytes
  acc.lines.push({ number: acc.totalLines, text })
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function finish(acc: WindowAccumulator, request: ReadWindow, displayPath: string): WindowResult {
  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, 'FS_NOT_FOUND')
  }
  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes }
}

/**
 * Build one window from streamed or whole-file chunks, enforcing line and byte caps and throwing
 * `FS_NOT_FOUND` when the requested offset is past EOF.
 * @param chunks - decoded text chunks in file order; chunk boundaries carry no meaning.
 * @param request - the resolved window; the caller has already applied its defaults and caps.
 * @param displayPath - the caller-facing path used in the offset-out-of-range error.
 * @returns the numbered window lines, the total line count seen, and the byte-cap truncation flag.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const acc = newAccumulator()
  // One char past the truncation point is enough to prove a line overflows.
  const lineBufferCap = request.maxLineLength + 1
  let lineBuffer = ''

  function appendToLineBuffer(segment: string): void {
    if (lineBuffer.length >= lineBufferCap) return
    lineBuffer += segment
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap)
  }

  function flushLine(): void {
    consumeLine(acc, stripCarriageReturn(lineBuffer), request)
    lineBuffer = ''
  }

  for await (const chunk of chunks) {
    let startPos = 0
    let newlinePos: number
    while ((newlinePos = chunk.indexOf('\n', startPos)) !== -1) {
      appendToLineBuffer(chunk.slice(startPos, newlinePos))
      flushLine()
      startPos = newlinePos + 1
      if (acc.done) return finish(acc, request, displayPath)
    }
    appendToLineBuffer(chunk.slice(startPos))
  }
  if (lineBuffer.length > 0) flushLine()
  return finish(acc, request, displayPath)
}

/**
 * Format a read outcome as one OpenCode-style line-numbered text block body.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param outcome - the windowed read to render.
 * @returns the model-facing envelope: numbered lines plus a continuation or end-of-file footer.
 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}
