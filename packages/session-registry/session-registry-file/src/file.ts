/**
 * Registry file format: the durable boundary between independent `dsh`
 * processes. Every field is validated on read because the medium is shared,
 * user-visible, and writable by other harness versions — a foreign or truncated
 * file must not crash `dsh list-sessions` into an empty listing that hides live sessions.
 * @module @deepseek-ai/dsh-session-registry-file/file
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { BootId, type SessionRegistryRecord } from '@deepseek-ai/dsh-session-registry'

/**
 * On-disk format version. Pinned at `0` under the pre-release stance: a
 * differing version is rejected rather than migrated, matching every other
 * harness backend.
 */
export const SESSION_REGISTRY_FORMAT_VERSION = 0

/** The complete registry file: a version stamp plus the live records. */
export interface RegistryFileContents {
  /** Format stamp, always {@link SESSION_REGISTRY_FORMAT_VERSION} when written. */
  readonly version: number
  /** One record per registered process, in no significant order. */
  readonly records: readonly SessionRegistryRecord[]
}

/** An empty registry: the value a missing file reads as. */
export const EMPTY_REGISTRY: RegistryFileContents = { version: SESSION_REGISTRY_FORMAT_VERSION, records: [] }

/** Narrow an unknown JSON value to a record shape, or reject it as unusable. */
function parseRecord(value: unknown): SessionRegistryRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const { sessionId, pid, cwd, startedAt, bootId } = row
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  // A non-integer or non-positive pid cannot be probed for liveness.
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (typeof cwd !== 'string' || cwd === '') return undefined
  if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt < 0) return undefined
  if (typeof bootId !== 'string' || bootId === '') return undefined
  // An absent title is legal (a fresh session has none); a present but
  // non-string one is a damaged row rather than a missing optional field.
  const { title } = row
  if (title !== undefined && typeof title !== 'string') return undefined
  return {
    sessionId: SessionId(sessionId),
    pid,
    cwd,
    startedAt,
    bootId: BootId(bootId),
    ...title !== undefined && { title },
  }
}

/**
 * Parse registry file text into records, dropping individually unusable rows.
 *
 * A row that cannot be interpreted is dropped rather than rejected wholesale:
 * one malformed record written by a different harness version must not hide
 * every other live session. Unparsable text and a version mismatch yield an
 * empty registry for the same reason — the caller republishes the whole file, so
 * the next write heals the medium.
 * @param text - the raw file contents.
 * @returns the records that parsed, and whether the text was fully understood.
 */
export function parseRegistry(text: string): { records: SessionRegistryRecord[]; intact: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Swallows only SyntaxError from this one JSON.parse: a torn or foreign
    // file heals on the next write, and nothing else can reach this catch.
    return { records: [], intact: false }
  }
  if (typeof parsed !== 'object' || parsed === null) return { records: [], intact: false }
  const file = parsed as Record<string, unknown>
  if (file.version !== SESSION_REGISTRY_FORMAT_VERSION) return { records: [], intact: false }
  if (!Array.isArray(file.records)) return { records: [], intact: false }
  const records: SessionRegistryRecord[] = []
  let intact = true
  for (const row of file.records) {
    const record = parseRecord(row)
    if (record === undefined) intact = false
    else records.push(record)
  }
  return { records, intact }
}

/**
 * Serialize records as registry file text.
 * @param records - the live records to publish.
 * @returns pretty-printed JSON with a trailing newline, for a legible medium.
 */
export function serializeRegistry(records: readonly SessionRegistryRecord[]): string {
  const file: RegistryFileContents = { version: SESSION_REGISTRY_FORMAT_VERSION, records }
  return `${JSON.stringify(file, undefined, 2)}\n`
}
