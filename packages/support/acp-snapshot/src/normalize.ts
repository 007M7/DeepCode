/**
 * Pure normalizers for the ACP snapshot goldens. They replace the
 * non-deterministic values in the two captured surfaces — the stdout JSON-RPC
 * transcript and the persisted session JSONL — with stable tokens, so a golden
 * compare reflects behavior, not run-to-run noise. Kept dependency-free and
 * side-effect-free so they unit-test trivially.
 *
 * Scrubbed: `randomUUID()` session ids → `{{sessionId}}`; the temp `mkdtemp`
 * cwd → `{{cwd}}` (it appears in terminal-card `_meta` and the log header);
 * JSON-RPC request `id` → a stable per-transcript sequence; the log's per-event
 * `time` (epoch ms) and header `createdAt` → 0; a `hook/result` event's
 * `durationMs` (wall-clock hook runtime) → 0. NOT scrubbed: the log's `seq`
 * (deterministic — `seq = log.length`, part of the event-log contract).
 *
 * A separate, composable normalizer — {@link scrubRequestHeaders} — replaces
 * the bulky request-header CONTENT (the composed system prompt, the tool
 * schema list, and the session prefix) with
 * `{{system}}`/`{{tools}}`/`{{messagePrefix}}` tokens. It is deliberately NOT
 * folded into {@link normalizeSessionLog}: each suite's one header-pinning
 * scenario compares that content verbatim, every other scenario composes the
 * scrub in (the `pinsHeader` flag on the scenario table, consumed by the suite
 * factory in ./suite.ts; see the pinned-header RFC,
 * docs/rfc/implemented/testing/2026-07-06-pin-request-header-content-in-one-scenario.md).
 *
 * See docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md.
 *
 * @module @deepseek-ai/dsh-acp-snapshot/normalize
 */

const SESSION_ID = '{{sessionId}}'
const CWD = '{{cwd}}'
const SYSTEM = '{{system}}'
const TOOLS = '{{tools}}'
const MESSAGE_PREFIX = '{{messagePrefix}}'

/** A UUID v4 string, the shape `randomUUID()` produces for session ids. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Inputs the normalizers need to recognize a run's volatile values. */
export interface NormalizeContext {
  /** The session id(s) the run issued — replaced with `{{sessionId}}`. */
  sessionIds: string[]
  /** The temp cwd the run used — replaced with `{{cwd}}`. */
  cwd: string
}

/** Replace cwd, session ids, and any stray UUID with stable tokens in a string. */
function scrubString(value: string, ctx: NormalizeContext): string {
  let out = value
  // cwd first (longest, most specific), then explicit session ids, then any
  // residual UUID (covers ids that appear in places we didn't enumerate).
  out = out.split(ctx.cwd).join(CWD)
  for (const id of ctx.sessionIds) out = out.split(id).join(SESSION_ID)
  out = out.replace(UUID_RE, SESSION_ID)
  return out
}

/** Recursively scrub a parsed JSON value (strings replaced; structure kept). */
function scrubValue(value: unknown, ctx: NormalizeContext): unknown {
  if (typeof value === 'string') return scrubString(value, ctx)
  if (Array.isArray(value)) return value.map(v => scrubValue(v, ctx))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, ctx)
    return out
  }
  return value
}

/**
 * Normalize a raw stdout transcript (newline-delimited JSON-RPC frames) into a
 * stable golden in the SAME shape as the wire: one compact JSON frame per line
 * (NDJSON), with the JSON-RPC `id` rewritten to a per-transcript sequence
 * (1, 2, 3, …) and all volatile strings scrubbed. Throws if any non-empty line
 * is not valid JSON — that doubles as the stdout-purity check (no logger leaked
 * onto the protocol).
 *
 * @param rawStdout The captured stdout bytes, decoded utf8.
 * @param ctx The run's volatile values to scrub.
 * @returns The normalized NDJSON transcript, one frame per line.
 */
export function normalizeStdout(rawStdout: string, ctx: NormalizeContext): string {
  const lines = rawStdout.split('\n').filter(line => line.trim().length > 0)
  // Map each distinct JSON-RPC id (request/response correlate by id) to a stable
  // sequence number, in first-seen order, so id churn doesn't perturb the golden.
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
    return scrubValue(frame, ctx) as Record<string, unknown>
  })
  return frames.map(f => JSON.stringify(f)).join('\n') + '\n'
}

/**
 * Normalize a session JSONL log into a stable golden: the header line's
 * volatile fields (`createdAt`, `id`, `cwd`) and every event's `time` are
 * zeroed/scrubbed, all volatile strings scrubbed, and `seq` is LEFT INTACT
 * (deterministic by contract). Output is JSONL in the same shape as the input —
 * one compact record per line.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @param ctx The run's volatile values to scrub.
 * @returns The normalized JSONL log, one record per line.
 */
export function normalizeSessionLog(rawLog: string, ctx: NormalizeContext): string {
  const lines = rawLog.split('\n').filter(line => line.trim().length > 0)
  const records = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    // Header line: { type: 'session', createdAt, id, cwd, … }.
    if (record.type === 'session') {
      if ('createdAt' in record) record.createdAt = 0
    } else if ('time' in record) {
      // Event line: zero the epoch-ms timestamp; keep seq (deterministic).
      record.time = 0
      // A hook/result carries the hook's wall-clock runtime (`data.durationMs`),
      // which is run-to-run noise like `time` — zero it so the golden reflects
      // the hook's decision/exit, not how long the shell took.
      if (record.type === 'hook/result' && record.data !== null && typeof record.data === 'object') {
        const data = record.data as Record<string, unknown>
        if ('durationMs' in data) data.durationMs = 0
      }
    }
    return scrubValue(record, ctx) as Record<string, unknown>
  })
  return records.map(r => JSON.stringify(r)).join('\n') + '\n'
}

/**
 * Replace request-header CONTENT in a session JSONL with stable tokens,
 * keeping its structure: a `request/header` event's `data.header.system` →
 * `{{system}}`, `data.header.tools` → `{{tools}}`, and
 * `data.header.messagePrefix` → one `{{messagePrefix}}` token per message
 * (the session prefix is model-visible bulk — an AGENTS digest, a skills
 * catalog — so its COUNT stays a structural fact while its text never lands
 * in a fixture); a
 * `request/header-delta` event keeps every structural fact — the system
 * delta's `keepStart`/`keepEnd` line positions and inserted-line COUNT (one
 * `{{system}}` token per inserted line), the tools delta's
 * added/removed/changed tool NAMES, the prefix replacement's message COUNT —
 * and tokenizes only the bulk (prompt
 * text; each added/changed schema's fields other than `name` → `{{tools}}`;
 * each replacement prefix message → `{{messagePrefix}}`),
 * so two different deltas still compare different.
 * Absent fields stay absent — WHETHER a header carried a system prompt,
 * tools, or a prefix is behavior and stays visible; `config` and `reason`
 * are small and
 * stable, so they stay verbatim (a model swap churns every fixture by design
 * — it invalidates the recorded responses; a prompt/schema edit churns none —
 * replay never reads this content, see dsh-llm-replay).
 *
 * Only lines with something to scrub are re-serialized; every other line
 * passes through byte-for-byte, so the transform is idempotent and applying
 * it to an already-scrubbed fixture is a no-op — the on-disk-fixtures guard
 * in ./suite.ts relies on exactly that.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with header content tokenized, other lines byte-identical.
 */
export function scrubRequestHeaders(rawLog: string): string {
  const lines = rawLog.split('\n')
  const out = lines.map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    const data = record.data as Record<string, unknown> | null | undefined
    if (data === null || typeof data !== 'object') return line
    if (record.type === 'request/header') {
      const header = data.header as Record<string, unknown> | null | undefined
      if (header === null || typeof header !== 'object') return line
      if (!('system' in header) && !('tools' in header) && !('messagePrefix' in header)) return line
      if ('system' in header) header.system = SYSTEM
      if ('tools' in header) header.tools = TOOLS
      if (Array.isArray(header.messagePrefix)) header.messagePrefix = header.messagePrefix.map(() => MESSAGE_PREFIX)
      return JSON.stringify(record)
    }
    if (record.type === 'request/header-delta') {
      let touched = false
      const system = data.system as Record<string, unknown> | null | undefined
      if (system !== null && typeof system === 'object' && Array.isArray(system.insert)) {
        system.insert = system.insert.map(() => SYSTEM)
        touched = true
      }
      const tools = data.tools as Record<string, unknown> | null | undefined
      if (tools !== null && typeof tools === 'object') {
        if (Array.isArray(tools.added)) { tools.added = tools.added.map(scrubToolSchema); touched = true }
        if (Array.isArray(tools.changed)) { tools.changed = tools.changed.map(scrubToolSchema); touched = true }
      }
      if (Array.isArray(data.messagePrefix)) {
        data.messagePrefix = data.messagePrefix.map(() => MESSAGE_PREFIX)
        touched = true
      }
      return touched ? JSON.stringify(record) : line
    }
    return line
  })
  return out.join('\n')
}

/** Tokenize one tool schema's bulk (description, parameters, anything else), keeping its identifying `name`. */
function scrubToolSchema(tool: unknown): unknown {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return tool
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(tool)) out[k] = k === 'name' ? v : TOOLS
  return out
}
