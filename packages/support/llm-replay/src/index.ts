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
 * snapshot harness — this plugin does not record.
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
  /** Path to the per-scenario `session.jsonl` fixture (the recorded log). */
  file: string
  /**
   * Optional path to a `ReplayEntry[]` sidecar that REPLACES the derived
   * script. Used by the two scenarios not expressible as `assistant/chunk`
   * (pure throw-before-chunk, cancel/hang). Absent for normal scenarios.
   */
  overrideFile?: string
}

/**
 * Parse a session `.jsonl` buffer into its event list. Line 0 is the session
 * header (a `{type:'session',…}` record), every subsequent non-empty line is a
 * {@link SessionEvent}. The header is skipped; malformed lines fail loud.
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
 * Build the replay script for a scenario: the sidecar override if present,
 * otherwise the script derived from the recorded session JSONL. Fail-loud if
 * the JSONL fixture is missing (the scenario was never recorded) — never
 * silently returns an empty script, so a coverage hole can't masquerade as a
 * passing replay.
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
 * Replay is POSITIONAL: the Nth `stream()` call serves the Nth script entry.
 * This is deterministic only with at most one model stream in flight at a time;
 * the snapshot harness runs one ACP session per scenario to guarantee that. The
 * cursor is advanced synchronously at listener-invocation time (not lazily
 * inside the generator) so call ORDER, not iteration order, fixes the mapping.
 */
export function installLlmReplay(ctx: Context, config: ReplayConfig): () => void {
  const entries = loadReplayScript(config)
  let cursor = 0
  return ctx.on('llm/stream', (options: GenerateOptions, _next) => {
    const index = cursor++
    const entry: ReplayEntry | undefined = entries[index]
    return (async function* () {
      if (entry === undefined) {
        throw new Error(
          `llm-replay: script exhausted — requested model call #${index + 1} but the fixture has only ${entries.length}; re-record the scenario`,
        )
      }
      yield* replayEntry(entry, options.signal)
    })()
  })
}

export const name = 'llm-replay'
export const inject = ['llm']

export interface Config {
  /** Override the fixture path; defaults to `$DSH_SNAPSHOT_FILE`. */
  file?: string
  /** Override the sidecar path; defaults to `$DSH_SNAPSHOT_OVERRIDE`. */
  overrideFile?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const file = config.file ?? process.env.DSH_SNAPSHOT_FILE
  if (file === undefined || file.length === 0) {
    throw new Error('llm-replay: a fixture path is required (Config.file or $DSH_SNAPSHOT_FILE)')
  }
  const overrideFile = config.overrideFile ?? process.env.DSH_SNAPSHOT_OVERRIDE
  installLlmReplay(ctx, overrideFile === undefined || overrideFile.length === 0 ? { file } : { file, overrideFile })
}
