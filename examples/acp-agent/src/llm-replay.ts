/**
 * Record/replay LLM plugin for snapshot tests.
 *
 * Installs a single `llm/stream` waterfall listener that, in `record` mode,
 * tees the real model's streamed {@link StreamChunk}s into a fixture file, and
 * in `replay` mode short-circuits the waterfall (never calls `next()`) to yield
 * previously-recorded streams deterministically. This is the seam that lets a
 * snapshot test boot the real agent against a fixed model transcript with no
 * API key — see docs/rfc/implemented/2026-06-19-acp-snapshot-tests.md.
 *
 * It lives in the example (not packages/) because it is example/test
 * infrastructure with one consumer, exactly like echo-agent's `mock-llm.ts`;
 * the capability-seams rule says not to split into a published package
 * preemptively.
 *
 * Plugin export shape: named `name`/`inject`/`Config`/`apply`, NO default
 * export (the cordis Loader's `unwrapExports` does `exports.default ?? exports`,
 * so a stray default would drop the namespace — see docs/postmortem/0001).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Context } from 'cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError, assertNever } from '@deepseek-ai/dsh-llm'

/**
 * One recorded model call. A discriminated union (not a bare `StreamChunk[]`)
 * so it can faithfully replay BOTH branches of the documented LLM failure
 * contract — an adapter may THROW from `stream()` or end with a `finish` error
 * chunk — plus a `hang` marker for cancellation scenarios (mirrors the
 * `MockAdapter` `hang` support in packages/agent-loop/tests).
 *
 * A `throw` entry carries any `chunks` the adapter emitted BEFORE it threw, so
 * a mid-stream transport failure (partial output then `STREAM_CLOSED`) replays
 * the partial chunks first and only then throws — exactly what the agent loop
 * saw live (it may already have emitted partial assistant chunks).
 */
export type ReplayEntry =
  | { kind: 'chunks'; chunks: StreamChunk[] }
  | { kind: 'throw'; chunks: StreamChunk[]; message: string; code: string; status?: number }
  | { kind: 'hang' }

/** Resolved plugin configuration. */
export interface ReplayConfig {
  /** `record` tees the real model to `file`; `replay` serves `file` back. */
  mode: 'record' | 'replay'
  /** Path to the per-scenario `llm.json` fixture. */
  file: string
}

/**
 * Read and validate a fixture file. Throws a clear, fail-loud error when the
 * file is missing (the scenario was never recorded) or malformed — never
 * silently returns an empty script, so a coverage hole can't masquerade as a
 * passing replay.
 */
export function loadFixture(file: string): ReplayEntry[] {
  if (!existsSync(file)) {
    throw new Error(`llm-replay: fixture not found: ${file} — run \`pnpm run test:snapshot:record\` first`)
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) {
    throw new Error(`llm-replay: fixture is not a JSON array: ${file}`)
  }
  // The fixture round-trips StreamChunk through JSON; branded CallId fields
  // deserialize as plain strings, which are structurally StreamChunk. We trust
  // the file shape (it is committed and produced by record mode) rather than
  // deep-validating every chunk.
  return parsed as ReplayEntry[]
}

/** Atomically write the recorded entries to `file` (temp write + rename). */
function flushFixture(file: string, entries: ReplayEntry[]): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8' })
  renameSync(tmp, file)
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
      return
    default:
      // Closed local union: an unknown kind means malformed (hand-edited or
      // drifted) fixture data — fail loud with a runtime diagnostic.
      return assertNever(entry, 'llm-replay fixture entry')
  }
}

/**
 * Install the record/replay `llm/stream` listener on `ctx`. Returns the
 * listener disposer (so a fiber dispose removes it — HMR safety). Exported
 * separately from {@link apply} so unit tests can drive it without the Loader
 * or env vars.
 *
 * Replay is POSITIONAL: the Nth `stream()` call serves the Nth fixture entry.
 * This is deterministic only with at most one model stream in flight at a time;
 * the snapshot harness runs one ACP session per scenario to guarantee that. The
 * cursor is advanced synchronously at listener-invocation time (not lazily
 * inside the generator) so call ORDER, not iteration order, fixes the mapping.
 */
export function installLlmReplay(ctx: Context, config: ReplayConfig): () => void {
  if (config.mode === 'replay') {
    const entries = loadFixture(config.file)
    let cursor = 0
    return ctx.on('llm/stream', (_options: GenerateOptions, _next) => {
      const index = cursor++
      const entry: ReplayEntry | undefined = entries[index]
      return (async function* () {
        if (entry === undefined) {
          throw new Error(
            `llm-replay: fixture exhausted — requested model call #${index + 1} but ${config.file} has only ${entries.length}; re-record the scenario`,
          )
        }
        yield* replayEntry(entry, _options.signal)
      })()
    })
  }

  // Record mode: delegate to the real adapter via next(), tee each chunk, and
  // flush atomically after EACH completed stream — the subprocess is SIGKILLed
  // by the test teardown and start.ts has no disposal path, so a dispose-time
  // flush would never run (see the RFC).
  const recorded: ReplayEntry[] = []
  return ctx.on('llm/stream', (_options: GenerateOptions, next) => {
    const inner = next()
    return (async function* () {
      const chunks: StreamChunk[] = []
      try {
        for await (const chunk of inner) {
          chunks.push(chunk)
          yield chunk
        }
      } catch (error) {
        const code = error instanceof LlmError ? error.code : 'UNKNOWN'
        const status = error instanceof LlmError ? error.status : undefined
        const message = error instanceof Error ? error.message : String(error)
        // Record the chunks emitted before the throw alongside the error, so
        // replay reproduces the same partial output + failure.
        const entry: ReplayEntry = status === undefined
          ? { kind: 'throw', chunks, message, code }
          : { kind: 'throw', chunks, message, code, status }
        recorded.push(entry)
        flushFixture(config.file, recorded)
        throw error
      }
      recorded.push({ kind: 'chunks', chunks })
      flushFixture(config.file, recorded)
    })()
  })
}

export const name = 'llm-replay'
export const inject = ['llm']

export interface Config {
  /** Override the mode; defaults to `$DSH_SNAPSHOT` (`record`) else `replay`. */
  mode?: 'record' | 'replay'
  /** Override the fixture path; defaults to `$DSH_SNAPSHOT_FILE`. */
  file?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const mode = config.mode ?? (process.env.DSH_SNAPSHOT === 'record' ? 'record' : 'replay')
  const file = config.file ?? process.env.DSH_SNAPSHOT_FILE
  if (file === undefined || file.length === 0) {
    throw new Error('llm-replay: a fixture path is required (Config.file or $DSH_SNAPSHOT_FILE)')
  }
  installLlmReplay(ctx, { mode, file })
}
