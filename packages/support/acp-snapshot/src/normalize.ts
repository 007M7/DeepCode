/**
 * Pure ACP transcript and session-log normalizers. They scrub session ids, run cwd, RPC ids,
 * timestamps, and hook duration while preserving deterministic event sequence numbers.
 * Request-header scrubbers stay composable so one scenario per header class can pin prompt and
 * tool-schema sidecars while retaining any model-visible prefix in the session log.
 * @module @deepseek-ai/dsh-acp-snapshot/normalize
 */

const SESSION_ID = '{{sessionId}}'
const CWD = '{{cwd}}'
const SYSTEM = '{{system}}'
const TOOLS = '{{tools}}'
const MESSAGE_PREFIX = '{{messagePrefix}}'
const UPDATED_AT = '{{updatedAt}}'

/** A cwd-rooted path after volatile cwd replacement, through its last separator-delimited segment. */
const CWD_ROOTED_PATH_RE = /\{\{cwd\}\}(?:[\\/][^\s<>"'`]+)+/g
const PATH_TAG_RE = /(<path>)([^<]*)(<\/path>)/g
const ADDITIONAL_INSTRUCTIONS_PATH_RE = /(Additional instructions from: )([^\r\n]+)/g

/** A UUID v4 string, the shape `randomUUID()` produces for session ids. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const LOCAL_SPILL_PATH_RE = new RegExp(
  String.raw`\{\{cwd\}\}[\\/]\.spill[\\/]session-[0-9a-f]{12}[\\/][0-9a-f]{12}-([A-Za-z0-9._~-]+?)`
  + String.raw`(?=\. Use read with offset/limit|[\s)]|$)`,
  'g',
)
const SNAPSHOT_SPILL_PATH_RE = new RegExp(
  String.raw`(?:[A-Za-z]:)?[\\/](?:tmp|t)[\\/](?:dsh-acp-snap-[0-9a-f]{9}|dsh-acp-snapshot-spill)[\\/]session-[0-9a-f]{12}[\\/][0-9a-f]{12}-([A-Za-z0-9._~-]+?)`
  + String.raw`(?=\. Use read with offset/limit|[\s)]|$)`,
  'g',
)

/** Convert separators only inside generated path-bearing text markers. */
function canonicalizeEmbeddedPaths(value: string): string {
  return value
    .replace(PATH_TAG_RE, (_match, open: string, path: string, close: string) =>
      `${open}${path.replaceAll('\\', '/')}${close}`)
    .replace(ADDITIONAL_INSTRUCTIONS_PATH_RE, (_match, prefix: string, path: string) =>
      `${prefix}${path.replaceAll('\\', '/')}`)
}

/** Inputs the normalizers need to recognize a run's volatile values. */
export interface NormalizeContext {
  /** The session id(s) the run issued — replaced with `{{sessionId}}`. */
  sessionIds: string[]
  /** The generated cwd the run used — replaced with `{{cwd}}`. */
  cwd: string
  /** Other filesystem spellings of the same cwd (for example Windows short and long paths). */
  cwdAliases?: readonly string[]
}

/** How cwd-rooted path separators are represented after the cwd is tokenized. */
export type CwdPathMode = 'canonical' | 'native'

/** Optional controls shared by stdout and session-log normalization. */
export interface NormalizeOptions {
  /** Use `/` for shared goldens, or preserve captured separators for a platform-specific golden. */
  cwdPathMode?: CwdPathMode
}

/** Replace cwd, session ids, and any stray UUID with stable tokens in a string. */
function scrubString(value: string, ctx: NormalizeContext, cwdPathMode: CwdPathMode): string {
  let out = value
  // Filesystem APIs can report one directory with several spellings. Replace
  // every known spelling longest-first so a shorter alias cannot corrupt a
  // longer one before it is tokenized.
  const cwdSpellings = [...new Set([ctx.cwd, ...ctx.cwdAliases ?? []])]
    .filter(spelling => spelling.length > 0)
    .sort((left, right) => right.length - left.length)
  for (const spelling of cwdSpellings) out = out.split(spelling).join(CWD)
  out = out.split(`/private${CWD}`).join(CWD)
  if (cwdPathMode === 'canonical') {
    // Restrict separator conversion to paths rooted at the cwd token. A global
    // backslash rewrite would corrupt regexes, commands, and model-authored text.
    out = out.replace(CWD_ROOTED_PATH_RE, path => path.replaceAll('\\', '/'))
    out = canonicalizeEmbeddedPaths(out)
  }
  out = out.replace(LOCAL_SPILL_PATH_RE, (_match, name: string) => `{{spillLocator:${name}}}`)
  out = out.replace(SNAPSHOT_SPILL_PATH_RE, (_match, name: string) => `{{spillLocator:${name}}}`)
  for (const id of ctx.sessionIds) out = out.split(id).join(SESSION_ID)
  out = out.replace(UUID_RE, SESSION_ID)
  return out
}

/** Recursively scrub a parsed JSON value (strings replaced; structure kept). */
function scrubValue(value: unknown, ctx: NormalizeContext, cwdPathMode: CwdPathMode, key?: string): unknown {
  if (typeof value === 'string') {
    const scrubbed = scrubString(value, ctx, cwdPathMode)
    return cwdPathMode === 'canonical' && key === 'path' ? scrubbed.replaceAll('\\', '/') : scrubbed
  }
  if (Array.isArray(value)) return value.map(v => scrubValue(v, ctx, cwdPathMode))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, ctx, cwdPathMode, k)
    return out
  }
  return value
}

/**
 * Normalize a raw stdout transcript (newline-delimited JSON-RPC frames) into a stable expected output
 * in the same shape as the wire: one compact JSON frame per line (NDJSON), with the JSON-RPC
 * `id` rewritten to a per-transcript sequence (1, 2, 3, …) and all volatile strings scrubbed.
 * Invalid JSON throws, doubling as a protocol-stdout purity check.
 *
 * @param rawStdout The captured stdout bytes, decoded utf8.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized NDJSON transcript, one frame per line.
 */
export function normalizeStdout(
  rawStdout: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  const cwdPathMode = options.cwdPathMode ?? 'canonical'
  const lines = rawStdout.split('\n').filter(line => line.trim().length > 0)
  // Map each distinct JSON-RPC id (request/response correlate by id) to a stable
  // sequence number, in first-seen order, so id churn doesn't perturb the expected output.
  const idSeq = new Map<string, number>()
  const stableId = (id: unknown): number => {
    const key = JSON.stringify(id)
    let n = idSeq.get(key)
    if (n === undefined) { n = idSeq.size + 1; idSeq.set(key, n) }
    return n
  }
  const frames = lines.map((line) => {
    const frame = JSON.parse(line) as Record<string, unknown>
    if ('id' in frame && frame.id !== undefined && frame.id !== null) {
      frame.id = stableId(frame.id)
    }
    const update = (frame.params as { update?: Record<string, unknown> } | undefined)?.update
    if (update?.sessionUpdate === 'session_info_update') update.updatedAt = UPDATED_AT
    return scrubValue(frame, ctx, cwdPathMode) as Record<string, unknown>
  })
  return frames.map(f => JSON.stringify(f)).join('\n') + '\n'
}

/**
 * Normalize a session JSONL log into a stable expected output: the header line's
 * volatile fields (`createdAt`, `id`, `cwd`) and every event's `time` are
 * zeroed/scrubbed, all volatile strings scrubbed, and `seq` is LEFT INTACT
 * (deterministic by contract). A packed chunk row's timing (`time0`, the `dt`
 * gaps) zeroes just like an event `time`; its `seq0` stays, like `seq`.
 * Output is JSONL in the same shape as the input — one compact record per
 * line.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized JSONL log, one record per line.
 */
export function normalizeSessionLog(
  rawLog: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  const cwdPathMode = options.cwdPathMode ?? 'canonical'
  const lines = rawLog.split('\n').filter(line => line.trim().length > 0)
  const records = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    // Header line: { type: 'session', createdAt, id, cwd, … }.
    if (record.type === 'session') {
      if ('createdAt' in record) record.createdAt = 0
    } else if ('time0' in record) {
      // Packed chunk row: zero the anchor timestamp and every member gap.
      record.time0 = 0
      const data = record.data
      if (data !== null && typeof data === 'object' && Array.isArray((data as { dt?: unknown }).dt)) {
        (data as { dt: unknown[] }).dt = (data as { dt: unknown[] }).dt.map(() => 0)
      }
    } else if ('time' in record) {
      // Event line: zero the epoch-ms timestamp; keep seq (deterministic).
      record.time = 0
      // A hook/result carries the hook's wall-clock runtime (`data.durationMs`),
      // which is run-to-run noise like `time` — zero it so the expected output reflects
      // the hook's decision/exit, not how long the shell took.
      if (record.type === 'hook/result' && record.data !== null && typeof record.data === 'object') {
        const data = record.data as Record<string, unknown>
        if ('durationMs' in data) data.durationMs = 0
      }
    }
    return scrubValue(record, ctx, cwdPathMode) as Record<string, unknown>
  })
  return records.map(r => JSON.stringify(r)).join('\n') + '\n'
}

/**
 * Replace system-prompt content in request headers with `{{system}}` tokens
 * while retaining field presence.
 * Other header content stays verbatim, so a header-pinning fixture can keep
 * its complete tool schemas while every JSONL fixture omits the prompt text.
 * Lines without a system payload pass through byte-for-byte; the transform is
 * idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with system-prompt content tokenized.
 */
export function scrubSystemPrompts(rawLog: string): string {
  return scrubHeaderContent(rawLog, { system: true })
}

/**
 * Replace tool schemas in full request-header snapshots with `{{tools}}`
 * tokens while retaining field presence. System prompts and session-prefix
 * messages stay verbatim so pinning fixtures can move only schema bulk into
 * their dedicated JSON sidecar. Lines without a tool payload pass through
 * byte-for-byte; the transform is idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with tool-schema content tokenized.
 */
export function scrubToolSchemas(rawLog: string): string {
  return scrubHeaderContent(rawLog, { tools: true })
}

/**
 * Replace all bulky request-header content in a session JSONL with stable
 * tokens. This includes the system-prompt fields handled by
 * {@link scrubSystemPrompts}, tool schemas, and session-prefix messages. It
 * keeps prefix message counts, field presence, config, and reason. Lines
 * without content to scrub pass through byte-for-byte, and the transform is
 * idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with all header bulk tokenized, other lines byte-identical.
 */
export function scrubRequestHeaders(rawLog: string): string {
  return scrubHeaderContent(rawLog, { system: true, tools: true, prefix: true })
}

/** Which independent request-header payloads a scrubber replaces. */
interface HeaderScrubOptions {
  system?: boolean
  tools?: boolean
  prefix?: boolean
}

/** Transform the selected request-header payloads. */
function scrubHeaderContent(rawLog: string, options: HeaderScrubOptions): string {
  const lines = rawLog.split('\n')
  const out = lines.map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    const data = record.data as Record<string, unknown> | null | undefined
    if (data === null || typeof data !== 'object') return line
    if (record.type === 'request/header') {
      const header = data.header as Record<string, unknown> | null | undefined
      if (header === null || typeof header !== 'object') return line
      let touched = false
      if (options.system === true && 'system' in header) { header.system = SYSTEM; touched = true }
      if (options.tools === true && 'tools' in header) { header.tools = TOOLS; touched = true }
      if (options.prefix === true && Array.isArray(header.messagePrefix)) {
        header.messagePrefix = header.messagePrefix.map(() => MESSAGE_PREFIX)
        touched = true
      }
      return touched ? JSON.stringify(record) : line
    }
    return line
  })
  return out.join('\n')
}
