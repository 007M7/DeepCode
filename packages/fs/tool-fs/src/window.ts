/**
 * Cordis-free line-windowing for `@deepseek-ai/dsh-tool-fs`. Turning a file's
 * decoded text into a bounded, line-numbered window (offset/limit, byte cap,
 * per-line truncation) is the model-facing READ-RENDERING detail the tool owns
 * now that the tool reads through `ctx.fs` directly — it is not a storage
 * primitive and not freshness policy.
 *
 * The provider (`ctx.fs.readText`/`streamText`) hands back already-decoded text
 * (UTF-8 validated, binary rejected); this module only scans that text for
 * newlines and builds the requested window. A capped line buffer means a
 * newline-free giant line can never balloon memory even when streamed.
 *
 * @module @deepseek-ai/dsh-tool-fs/window
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** Maximum characters returned for a single line. */
export const READ_MAX_LINE_LENGTH = 2000

/** Maximum bytes returned for selected file lines. */
export const READ_MAX_BYTES = 50 * 1024

const READ_MAX_LINE_SUFFIX = `... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
const LINE_BUFFER_CAP = READ_MAX_LINE_LENGTH + 1

/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface ReadWindow {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines to return. */
  limit: number
}

/** One line returned from a text file. */
export interface FileTextLine {
  /** 1-based line number in the file. */
  number: number
  /** Line text without its trailing newline. */
  text: string
}

/** The windowed result this module builds from a file's decoded text. */
export interface WindowResult {
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Total line count in the file, unless `truncatedByBytes` stopped scanning early. */
  totalLines: number
  /** Whether selected output hit the byte cap before EOF or the requested limit. */
  truncatedByBytes: boolean
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

function truncateLine(line: string): string {
  return line.length > READ_MAX_LINE_LENGTH ? `${line.substring(0, READ_MAX_LINE_LENGTH)}${READ_MAX_LINE_SUFFIX}` : line
}

function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function consumeLine(acc: WindowAccumulator, rawLine: string, request: ReadWindow): void {
  acc.totalLines += 1
  if (acc.totalLines < request.offset || acc.lines.length >= request.limit) return

  const text = truncateLine(rawLine)
  const bytes = lineByteSize(text, acc.lines.length)
  if (acc.outputBytes + bytes > READ_MAX_BYTES) {
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
 * Build a bounded, line-numbered window from a file's decoded text chunks.
 * Accepts an `AsyncIterable<string>` (a chunked `streamText`) or an
 * `Iterable<string>` (a whole-file `readText` wrapped as `[text]`), so one code
 * path serves both. Scans for newlines with a capped line buffer (a newline-free
 * giant line is truncated, never buffered past {@link READ_MAX_LINE_LENGTH}),
 * enforces the byte cap, and throws `FS_NOT_FOUND` for an offset past EOF.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const acc = newAccumulator()
  let lineBuffer = ''

  function appendToLineBuffer(segment: string): void {
    if (lineBuffer.length >= LINE_BUFFER_CAP) return
    lineBuffer += segment
    if (lineBuffer.length > LINE_BUFFER_CAP) lineBuffer = lineBuffer.slice(0, LINE_BUFFER_CAP)
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
