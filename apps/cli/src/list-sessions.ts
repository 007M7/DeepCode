/**
 * `dsh list-sessions` (alias `dsh ps`) — list the sessions running right now.
 *
 * A read-only surface: it mounts the session registry alone and never boots an
 * agent tree, so listing stays fast and cannot start model work as a side
 * effect. Liveness comes from the registry, which prunes records whose process
 * is gone, and every displayed field including the title comes from the record,
 * so no session log is opened and no backend format is assumed.
 * @module @deepseek-ai/dsh/list-sessions
 */

import { Context } from 'cordis'
import { type SessionRegistryRecord } from '@deepseek-ai/dsh-session-registry'
import SessionRegistryFile from '@deepseek-ai/dsh-session-registry-file'
import { registryRoot } from './register-session.ts'

/** Column header text, also the minimum width of each column. */
const HEADERS = ['SESSION', 'PID', 'UPTIME', 'WORKSPACE', 'TITLE'] as const

/** Shown when a session has no title yet. */
const NO_TITLE = '—'

/**
 * Render milliseconds of uptime as a compact human duration.
 * @param ms - elapsed milliseconds since the session registered.
 * @returns a short duration such as `12s`, `4m`, or `2h14m`.
 */
export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours < 24) return remainder === 0 ? `${String(hours)}h` : `${String(hours)}h${String(remainder)}m`
  const days = Math.floor(hours / 24)
  const leftoverHours = hours % 24
  return leftoverHours === 0 ? `${String(days)}d` : `${String(days)}d${String(leftoverHours)}h`
}

/** One fully-resolved listing row, in column order. */
type Row = readonly [string, string, string, string, string]

/**
 * Build the display rows for a listing, newest session first.
 * @param records - the live records to render.
 * @param now - the current epoch milliseconds uptime is measured against.
 * @returns one row per record, each already stringified per column.
 */
export function buildRows(records: readonly SessionRegistryRecord[], now: number): Row[] {
  return [...records]
    .sort((left, right) => right.startedAt - left.startedAt)
    .map(record => [
      record.sessionId,
      String(record.pid),
      formatUptime(now - record.startedAt),
      record.cwd,
      record.title ?? NO_TITLE,
    ] as const)
}

/**
 * Render rows as a left-aligned table with a header line.
 *
 * The last column is never padded, so a long title cannot add trailing
 * whitespace to every line.
 * @param rows - the rows to render, already stringified.
 * @returns the complete table text, newline-terminated.
 */
export function renderTable(rows: readonly Row[]): string {
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map(row => row[column]?.length ?? 0)))
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()
  return [line(HEADERS), ...rows.map(row => line(row))].join('\n') + '\n'
}

/**
 * List live sessions and exit. Prints a table by default, or a JSON array with
 * `--json`; an empty listing is a success, not an error.
 * @param json - emit the machine-readable JSON array instead of the table.
 */
export async function runListSessions(json: boolean): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionRegistryFile, { root: registryRoot() })
  const records = await ctx.sessionRegistry.list()
  await ctx.fiber.dispose()

  if (json) {
    const rows = [...records]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(record => ({ ...record, uptimeMs: Date.now() - record.startedAt, title: record.title ?? null }))
    process.stdout.write(`${JSON.stringify(rows, undefined, 2)}\n`)
    return
  }
  if (records.length === 0) {
    process.stdout.write('no dsh sessions running\n')
    return
  }
  process.stdout.write(renderTable(buildRows(records, Date.now())))
}
