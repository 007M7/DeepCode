/**
 * Replay LLM plugin for snapshot tests.
 *
 * Installs a single `llm/stream` waterfall listener that short-circuits the
 * waterfall (never calls `next()`) and yields model streams reconstructed from
 * a recorded **session JSONL** fixture — so a snapshot test can boot the real
 * agent against a fixed model transcript with no API key. See
 * docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md.
 *
 * The fixture IS the persisted session log (`<scenario>/session.jsonl`): its
 * `assistant/chunk` events carry every {@link StreamChunk}, so grouping them by
 * `(turn, step)` reconstructs each `stream()` call's chunk sequence (one model
 * call per loop step — see packages/core/agent-loop/src/loop.ts). Recording is
 * therefore "run the real agent once and harvest the `.jsonl`", done by the
 * snapshot harness — this plugin does not record. A fixture may carry its
 * `request/header` content tokenized to `{{system}}`/`{{tools}}` (the harness
 * pins that content in one scenario and scrubs the rest); replay is
 * indifferent — derivation reads ONLY `assistant/chunk` events and the line-0
 * session header.
 *
 * A NESTED-agent scenario records more than one log: the parent plus one per
 * in-process subagent (each subagent runs as its own {@link Session} on the same
 * context). Replay loads them all ({@link loadSessionScripts}), derives a script
 * per recorded session, and keys each live call by its calling session id
 * (`GenerateOptions.sessionId`, stamped by the loop). Live session ids are fresh
 * random values, so a live session binds to a recorded script by FIRST-CALL
 * order (parent first — it streams before it delegates); see
 * {@link installLlmReplay}.
 *
 * Two failure modes are NOT reconstructable from `assistant/chunk` alone — a
 * pure throw before any chunk (e.g. an HTTP 401: the log holds only a
 * `turn/end {error}`, no chunks) and a cancel/hang (timing, not chunk content).
 * A scenario that needs those supplies an optional sidecar
 * (`<scenario>/replay.override.json`: a `ReplayEntry[]`) that REPLACES the
 * derived script.
 *
 * It lives in its own package (not under `examples/`) so its derive/parse/
 * replay logic falls under the per-file 100% coverage gate on package `src`
 * trees — its tests previously lived under `examples/`, which the gate does
 * not measure, leaving these branches (clean chunks / mid-stream throw / hang)
 * unguarded. Its consumer is the ACP snapshot harness in `examples/acp-agent`,
 * which loads it (via `cordis.snapshot.yml`) in place of a real LLM adapter.
 *
 * Plugin export shape: named `name`/`inject`/`Config`/`apply`, NO default
 * export (the cordis Loader's `unwrapExports` does `exports.default ?? exports`,
 * so a stray default would drop the namespace — see docs/postmortem/0001).
 *
 * @module @deepseek-ai/dsh-llm-replay
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter as pathDelimiter } from 'node:path'
import type { Context } from 'cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError, assertNever } from '@deepseek-ai/dsh-llm'

/**
 * One recorded model call. A discriminated union (not a bare `StreamChunk[]`)
 * so it can faithfully replay BOTH branches of the documented LLM failure
 * contract — an adapter may THROW from `stream()` or end with a `finish` error
 * chunk — plus a `hang` marker for cancellation scenarios (mirrors the
 * `MockAdapter` `hang` support in packages/core/agent-loop/tests).
 *
 * A `throw` entry carries any `chunks` the adapter emitted BEFORE it threw, so
 * a mid-stream transport failure (partial output then `STREAM_CLOSED`) replays
 * the partial chunks first and only then throws — exactly what the agent loop
 * saw live (it may already have emitted partial assistant chunks).
 *
 * The normal/finish-terminated cases are DERIVED from the session JSONL
 * ({@link deriveReplayScript}); only the throw and hang cases need a
 * hand-authored sidecar entry (a thrown stream leaves no terminal `finish` in
 * the log, so it cannot be derived as `chunks`).
 */
export type ReplayEntry =
  | { kind: 'chunks'; chunks: StreamChunk[] }
  | { kind: 'throw'; chunks: StreamChunk[]; message: string; code: string; status?: number }
  | { kind: 'hang' }

/** Resolved plugin configuration. */
export interface ReplayConfig {
  /**
   * Path to the PRIMARY (parent) `session.jsonl` fixture. For a single-session
   * scenario this is the only log; for a nested-agent scenario it is the parent,
   * and the child logs ride in {@link childFiles}.
   */
  file: string
  /**
   * Optional `ReplayEntry[]` sidecar that REPLACES the derived script for the
   * PRIMARY session. Used by the two single-session scenarios not expressible as
   * `assistant/chunk` (pure throw-before-chunk, cancel/hang). Absent for normal
   * and nested scenarios.
   */
  overrideFile?: string
  /**
   * Additional recorded child-session logs (a nested-agent scenario's subagent
   * sessions). Each is derived independently; the full set is ordered by
   * `createdAt` so the parent (earliest) binds to the first live session. Empty
   * for a single-session scenario.
   */
  childFiles?: string[]
}

/**
 * One recorded session's replay script: the per-call entries plus the header
 * facts needed to ORDER and key it. Live session ids are freshly random at
 * replay time and never equal the recorded `id`, so the recorded id is only a
 * diagnostic; `createdAt` is the load-bearing field — scripts are ordered by it
 * (a parent is created before its children) and each newly-seen live session is
 * bound to the next script in that order (= first-call order in the synchronous
 * nested cut, where the parent streams before it delegates).
 */
export interface SessionScript {
  /** The recorded session id (diagnostics only — the live id differs). */
  recordedId: string
  /** Session creation time; the deterministic ordering key (parent < child). */
  createdAt: number
  /** The per-`stream()`-call replay entries, in recorded call order. */
  entries: ReplayEntry[]
  /**
   * Whether this is the PRIMARY (parent) session. Breaks a `createdAt` tie in
   * favor of the parent, which always issues the first model call.
   */
  primary: boolean
}

/**
 * Parse a session `.jsonl` buffer into its event list. Line 0 is the session
 * header (a `{type:'session',…}` record), every subsequent non-empty line is a
 * {@link SessionEvent}. The header is skipped; malformed lines fail loud.
 * @param text - the raw `.jsonl` file contents.
 * @returns every event after the header, in log order.
 */
export function parseSessionLog(text: string): SessionEvent[] {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const events: SessionEvent[] = []
  // Skip line 0 (the header). A reader distinguishes it by its `type:'session'`
  // tag; we simply drop the first line, which the JSONL backend guarantees is
  // the header.
  for (let i = 1; i < lines.length; i++) {
    const parsed: unknown = JSON.parse(lines[i] as string)
    events.push(parsed as SessionEvent)
  }
  return events
}

/**
 * Read the identifying facts off a session log's header line (line 0): the
 * recorded session `id` (diagnostics), `createdAt` (the deterministic ordering
 * key that binds a recorded script to a live session — see
 * {@link SessionScript}), and `seedLength` (the seed boundary — how many leading
 * events were INHERITED via a fork seed rather than produced by this session's
 * own model calls; absent ⇒ 0). A header missing a field falls back to a stable
 * default (`''` / `0` / `0`) rather than throwing: a no-model fixture is
 * header-only and still orders fine as the single (primary) script.
 * @param text - the raw `.jsonl` file contents (only the header line is read).
 * @returns the header's `id`, `createdAt`, and `seedLength`, defaulted when absent.
 */
export function parseSessionHeader(text: string): { id: string; createdAt: number; seedLength: number } {
  const firstLine = text.split('\n').find(line => line.trim().length > 0) ?? '{}'
  const parsed = JSON.parse(firstLine) as { id?: unknown; createdAt?: unknown; seedLength?: unknown }
  return {
    id: typeof parsed.id === 'string' ? parsed.id : '',
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
    seedLength: typeof parsed.seedLength === 'number' ? parsed.seedLength : 0,
  }
}

/**
 * Reconstruct the per-`stream()` replay script from a recorded session log.
 *
 * The agent loop makes exactly one `ctx.llm.stream()` call per step and appends
 * every chunk as an `assistant/chunk` event tagged with the current
 * `(turn, step)`. Grouping those events by `(turn, step)` in log order
 * therefore yields one `{kind:'chunks'}` entry per model call, in call order.
 *
 * A group is only valid if it ends in a `finish` chunk — the adapter contract
 * guarantees a successful (or finish-error) stream terminates with `finish`,
 * and the loop relies on it. A group WITHOUT a terminal `finish` is the
 * fingerprint of a *thrown* `stream()` (the loop recorded the prefix chunks,
 * then an `error`/`turn/end`, but no `finish`): such a stream cannot be
 * faithfully replayed as `{kind:'chunks'}` (that would look like a clean stop),
 * so deriving it is an error — the scenario must supply a `replay.override.json`
 * sidecar with an explicit `throw` (or `hang`) entry instead. {@link
 * deriveReplayScript} throws, naming the offending `(turn, step)`, so a missing
 * override fails loud rather than silently replaying a thrown call as success.
 * @param events - the recorded session's events; only `assistant/chunk` is consulted.
 * @returns one `chunks` entry per recorded model call, in call order.
 */
export function deriveReplayScript(events: SessionEvent[]): ReplayEntry[] {
  const script: ReplayEntry[] = []
  let currentKey: string | undefined
  let current: StreamChunk[] = []
  const close = (key: string | undefined, chunks: StreamChunk[]): void => {
    if (chunks.length === 0) return
    if (chunks[chunks.length - 1]?.type !== 'finish') {
      throw new Error(
        `llm-replay: model call ${key} ended without a finish chunk (a thrown stream); `
        + 'this scenario needs a replay.override.json sidecar',
      )
    }
    script.push({ kind: 'chunks', chunks })
  }
  for (const event of events) {
    if (event.type !== 'assistant/chunk') continue
    const { turn, step, chunk } = event.data
    const key = `${turn}/${step}`
    if (key !== currentKey) {
      // A new (turn, step) — i.e. a new stream() call. Close the previous one
      // (skip the initial empty buffer before any chunk has been seen).
      close(currentKey, current)
      currentKey = key
      current = []
    }
    current.push(chunk)
  }
  close(currentKey, current)
  return script
}

/**
 * Build the replay script for the PRIMARY session: the sidecar override if
 * present, otherwise the script derived from the recorded session JSONL.
 * Fail-loud if the JSONL fixture is missing (the scenario was never recorded) —
 * never silently returns an empty script, so a coverage hole can't masquerade
 * as a passing replay.
 * @param config - the fixture paths; only `file` and `overrideFile` are consulted.
 * @returns the primary session's replay entries.
 */
export function loadReplayScript(config: ReplayConfig): ReplayEntry[] {
  if (config.overrideFile !== undefined && existsSync(config.overrideFile)) {
    const parsed: unknown = JSON.parse(readFileSync(config.overrideFile, 'utf8'))
    if (!Array.isArray(parsed)) {
      throw new Error(`llm-replay: override is not a JSON array: ${config.overrideFile}`)
    }
    return parsed as ReplayEntry[]
  }
  if (!existsSync(config.file)) {
    throw new Error(`llm-replay: fixture not found: ${config.file} — run \`pnpm run test:snapshot:record\` first`)
  }
  return deriveReplayScript(parseSessionLog(readFileSync(config.file, 'utf8')))
}

/**
 * Load every recorded session's script for a scenario, ordered by `createdAt`
 * (earliest first), ready to bind to live sessions in first-call order.
 *
 * The PRIMARY session (`config.file`, with its optional `overrideFile`) is the
 * parent; each `config.childFiles` entry is a recorded subagent session. A
 * single-session scenario has no `childFiles`, so this returns one script and
 * behaves exactly like the old single-cursor replay. The primary always sorts
 * first when ties occur (a sub-millisecond parent/child `createdAt` collision):
 * the parent issues the FIRST model call (it must stream before it can delegate
 * in the synchronous nested cut), so binding it to the first live session is
 * correct regardless of a timestamp tie.
 * @param config - the fixture paths: the primary log plus any recorded child logs.
 * @returns the primary script first, then the child scripts in bind order.
 */
export function loadSessionScripts(config: ReplayConfig): SessionScript[] {
  const primaryEntries = loadReplayScript(config)
  // The override path replaces the derived script but carries no header; read
  // the header off the JSONL when it exists, else use a stable default so an
  // override-only fixture (header-less) still orders first as the primary.
  const primaryHeader = existsSync(config.file)
    ? parseSessionHeader(readFileSync(config.file, 'utf8'))
    : { id: '', createdAt: 0 }
  const primary: SessionScript = {
    recordedId: primaryHeader.id, createdAt: primaryHeader.createdAt, entries: primaryEntries, primary: true,
  }
  const children: SessionScript[] = []
  for (const childFile of config.childFiles ?? []) {
    if (!existsSync(childFile)) {
      throw new Error(`llm-replay: child fixture not found: ${childFile} — re-record the scenario`)
    }
    const text = readFileSync(childFile, 'utf8')
    const header = parseSessionHeader(text)
    // Derive the child's script from its OWN events only — events AT OR AFTER
    // the seed boundary. A FORK child's log begins with the seeded parent prefix
    // (the parent's events, including its `assistant/chunk`s); replaying those as
    // the child's model calls would feed the child the PARENT's recorded
    // responses. `seedLength` is 0 for a fresh (spawn) child, so this is a no-op
    // there.
    const ownEvents = parseSessionLog(text).slice(header.seedLength)
    children.push({
      recordedId: header.id,
      createdAt: header.createdAt,
      entries: deriveReplayScript(ownEvents),
      primary: false,
    })
  }
  // The primary (parent) always binds first — it issues the first model call,
  // because it must run a turn before it can delegate. Children follow in
  // createdAt order. In the current synchronous cut sibling children are created
  // STRICTLY SEQUENTIALLY — the subagent tool awaits one child's result and
  // disposes it before the parent's next tool call can start the next — so their
  // createdAt values are strictly ordered and match first-call order exactly.
  // The recordedId tiebreak only makes a degenerate same-millisecond collision
  // (unreachable in this cut) deterministic; it does NOT recover first-call
  // order, so it is arbitrary if such a tie ever occurs.
  // XXX(concurrent-subagents): a future cut that runs siblings concurrently or
  // backgrounded could create two children in the same millisecond, where this
  // createdAt+id order may diverge from first-call order. That cut must thread a
  // real first-call ordinal (the order live sessions first stream) instead of
  // leaning on createdAt — see the per-session-replay RFC.
  children.sort((a, b) => a.createdAt - b.createdAt || a.recordedId.localeCompare(b.recordedId))
  return [primary, ...children]
}

/** Yield a recorded stream back, honoring abort like a real adapter. */
async function* replayEntry(entry: ReplayEntry, signal: AbortSignal | undefined): AsyncIterable<StreamChunk> {
  switch (entry.kind) {
    case 'chunks':
      for (const chunk of entry.chunks) {
        if (signal?.aborted) throw new Error('aborted')
        yield chunk
      }
      return
    case 'throw':
      // Replay the THROW branch of the LLM contract: emit whatever the adapter
      // streamed before it threw (so the loop sees the same partial output it
      // saw live), then throw the recorded error (e.g. a provider 401, or a
      // mid-stream STREAM_CLOSED after partial chunks).
      for (const chunk of entry.chunks) {
        if (signal?.aborted) throw new Error('aborted')
        yield chunk
      }
      throw new LlmError(entry.message, entry.code, entry.status)
    case 'hang':
      // Replay a stream that stalls until cancelled (mirrors MockAdapter): one
      // chunk, then wait for abort and surface it as the consumer expects.
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) { reject(new Error('aborted')); return }
        signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      /* v8 ignore next -- unreachable: the hang promise only ever rejects (on abort), never resolves; control never reaches here */
      return
    default:
      // Closed local union: an unknown kind means malformed (hand-edited or
      // drifted) sidecar data — fail loud with a runtime diagnostic.
      return assertNever(entry, 'llm-replay replay entry')
  }
}

/**
 * Install the replay `llm/stream` listener on `ctx`. Returns the listener
 * disposer (so a fiber dispose removes it — HMR safety). Exported separately
 * from {@link apply} so unit tests can drive it without the Loader or env vars.
 *
 * Replay is PER-SESSION POSITIONAL: each recorded session has its own script
 * (parent + any subagent children, loaded by {@link loadSessionScripts} ordered
 * by `createdAt`), and the Nth `stream()` call FROM A GIVEN SESSION serves that
 * session's Nth entry. The calling session is read off `options.sessionId` (the
 * agent loop stamps it from `agent.session.id`).
 *
 * Live session ids are freshly random and never equal the recorded ones, so a
 * live session binds to a recorded script by FIRST-CALL ORDER: the first live
 * session to make any call takes the first ordered script (the parent — earliest
 * `createdAt`, and the first to stream because it must run before it delegates),
 * the next new live session takes the next script, and so on. This keys by WHO
 * calls rather than global call order, so it stays correct even if subagents
 * ever run concurrently/backgrounded (a global cursor would interleave them).
 *
 * A call with no `sessionId` (a direct unit-test `ctx.llm.stream` that omits it)
 * is treated as one anonymous session — it binds to the first script, so the
 * single-session path behaves exactly as the old global cursor did.
 *
 * Each per-session cursor advances synchronously at listener-invocation time
 * (not lazily inside the generator) so call ORDER within a session, not
 * iteration order, fixes the mapping.
 * @param ctx - the context whose `llm/stream` waterfall the listener short-circuits.
 * @param config - the resolved fixture paths (env-var defaulting is `apply`'s job).
 * @returns the `ctx.on` disposer that removes the listener.
 */
export function installLlmReplay(ctx: Context, config: ReplayConfig): () => void {
  const scripts = loadSessionScripts(config)
  // Live-session → its bound script + cursor. A new live session id claims the
  // next not-yet-bound script (scripts are in bind order); `nextScript` is the
  // index of the next unclaimed one.
  const bound = new Map<string, { entries: ReplayEntry[]; cursor: number }>()
  let nextScript = 0
  const ANON = '\0anon\0' // the key for a call that carries no sessionId
  return ctx.on('llm/stream', (options: GenerateOptions, _next) => {
    const key = options.sessionId ?? ANON
    let state = bound.get(key)
    let unrecorded = false
    if (state === undefined) {
      const script = scripts[nextScript]
      if (script === undefined) {
        // More distinct live sessions made calls than the scenario recorded —
        // an unrecorded subagent appeared. Defer the throw into the returned
        // generator (the listener must return an AsyncIterable, not throw).
        unrecorded = true
        state = { entries: [], cursor: 0 }
      } else {
        nextScript++
        state = { entries: script.entries, cursor: 0 }
        bound.set(key, state)
      }
    }
    const boundState = state
    const seenSessions = nextScript
    const totalScripts = scripts.length
    const index = boundState.cursor++
    const entry: ReplayEntry | undefined = boundState.entries[index]
    return (async function* () {
      if (unrecorded) {
        throw new Error(
          `llm-replay: a model call arrived from an unrecorded session (#${seenSessions + 1}); `
          + `the scenario recorded only ${totalScripts} session(s) — re-record it`,
        )
      }
      if (entry === undefined) {
        throw new Error(
          `llm-replay: script exhausted — session requested model call #${index + 1} `
          + `but its script has only ${boundState.entries.length}; re-record the scenario`,
        )
      }
      yield* replayEntry(entry, options.signal)
    })()
  })
}

export const name = 'llm-replay'
export const inject = ['llm']

/** Plugin config: the {@link ReplayConfig} inputs, each defaulting to its `DSH_SNAPSHOT_*` env var in `apply`. */
export interface Config {
  /** Override the fixture path; defaults to `$DSH_SNAPSHOT_FILE`. */
  file?: string
  /** Override the sidecar path; defaults to `$DSH_SNAPSHOT_OVERRIDE`. */
  overrideFile?: string
  /**
   * Override the child-log paths; defaults to `$DSH_SNAPSHOT_CHILD_FILES` (a
   * path-separator-delimited list). Each is a recorded subagent session log for
   * a nested-agent scenario; absent/empty for a single-session scenario.
   */
  childFiles?: string[]
}

export function apply(ctx: Context, config: Config = {}): void {
  const file = config.file ?? process.env.DSH_SNAPSHOT_FILE
  if (file === undefined || file.length === 0) {
    throw new Error('llm-replay: a fixture path is required (Config.file or $DSH_SNAPSHOT_FILE)')
  }
  const overrideFile = config.overrideFile ?? process.env.DSH_SNAPSHOT_OVERRIDE
  const childEnv = process.env.DSH_SNAPSHOT_CHILD_FILES
  const childFiles = config.childFiles
    ?? (childEnv !== undefined && childEnv.length > 0 ? childEnv.split(pathDelimiter) : [])
  installLlmReplay(ctx, {
    file,
    ...overrideFile !== undefined && overrideFile.length > 0 ? { overrideFile } : {},
    ...childFiles.length > 0 ? { childFiles } : {},
  })
}
