/**
 * Keyless snapshot-test LLM replay. It derives one model-call script per
 * recorded session from `assistant/chunk` events and binds fresh live sessions
 * to parent/child scripts by first-call order. Throw and hang cases require an
 * explicit override because a session log cannot reconstruct them alone.
 * @module @deepseek-ai/dsh-llm-replay
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter as pathDelimiter } from 'node:path'
import type { Context } from 'cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError, assertNever } from '@deepseek-ai/dsh-llm'

/**
 * One recorded model call. `throw` may replay prefix chunks before failing;
 * `hang` models cancellation. Only ordinary chunk entries derive from JSONL;
 * the other variants come from an override sidecar.
 */
export type ReplayEntry =
  | { kind: 'chunks'; chunks: StreamChunk[] }
  | { kind: 'throw'; chunks: StreamChunk[]; message: string; code: string }
  | { kind: 'hang' }

/** One model exposed by a replay-only provider catalog. */
export interface ReplayModelConfig {
  /** Model id used for replay requests. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector description. */
  description?: string
}

/** One provider route exposed by the replay adapter. */
export interface ReplayProviderConfig {
  /** Provider route used for replay requests. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Advisory models exposed to clients such as ACP editors. */
  models?: ReplayModelConfig[]
}

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
  /**
   * Optional provider catalog. When non-empty, replay registers an adapter for
   * these routes; when absent or empty, it retains the catch-all waterfall used
   * by tests that do not need discovery.
   */
  providers?: ReplayProviderConfig[]
}

/**
 * Recorded calls plus header facts used to order parent and child scripts.
 * Recorded ids are diagnostic; fresh live ids bind by ordered first use.
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
  // The JSONL backend guarantees line 0 is the session header.
  for (let i = 1; i < lines.length; i++) {
    const parsed: unknown = JSON.parse(lines[i] as string)
    events.push(parsed as SessionEvent)
  }
  return events
}

/**
 * Read replay identity, ordering, and fork-seed facts from the JSONL header.
 *
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
 * Groups `assistant/chunk` events by turn and step. Every group must end in a
 * `finish`; a missing terminator means the live stream threw, so derivation
 * rejects and the scenario must provide an explicit override.
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
 * Load the primary and child scripts in bind order. Child derivation begins at
 * `seedLength` so inherited parent chunks are never replayed as child calls.
 *
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
    // Derive the child's script from its own events only — events AT OR after the seed
    // boundary.
    const ownEvents = parseSessionLog(text).slice(header.seedLength)
    children.push({
      recordedId: header.id,
      createdAt: header.createdAt,
      entries: deriveReplayScript(ownEvents),
      primary: false,
    })
  }
  // Synchronous children start in creation order; the id only stabilizes timestamp ties.
  // XXX(concurrent-subagents): concurrent children need an explicit first-call ordinal.
  children.sort((a, b) => a.createdAt - b.createdAt || a.recordedId.localeCompare(b.recordedId))
  return [primary, ...children]
}

/** Replay adapter that makes a configured provider catalog discoverable without provider I/O. */
class ReplayAdapter extends LlmAdapter {
  private readonly providers: ReadonlyMap<string, ReplayProviderConfig>

  constructor(
    providers: readonly ReplayProviderConfig[],
    private readonly replay: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ) {
    super()
    this.providers = new Map(providers.map(provider => [provider.id, provider]))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const configured = this.providers.get(provider)
    /* v8 ignore next -- LlmService only asks about routes registered from this same map. */
    if (configured === undefined) return super.providerInfo(provider)
    return { id: provider, name: configured.name ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const configured = this.providers.get(provider)
    /* v8 ignore next -- LlmService only asks about routes registered from this same map. */
    if (configured === undefined) return Promise.resolve([])
    return Promise.resolve((configured.models ?? []).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.description === undefined ? {} : { description: model.description },
    })))
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.replay(options)
  }
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
      throw new LlmError(entry.message, entry.code)
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
 * Install per-session positional replay. A newly seen live session takes the
 * next ordered recorded script, then advances its own cursor synchronously at
 * invocation time; calls without `sessionId` share one anonymous session. A
 * non-empty provider catalog registers a routed replay adapter; otherwise a
 * catch-all waterfall intercepts requests. Returns the effect disposer for
 * HMR-safe removal.
 *
 * @param ctx - the context whose LLM service receives the replay route or waterfall.
 * @param config - the resolved fixture paths (env-var defaulting is `apply`'s job).
 * @returns the disposer that removes the registered adapter or listener.
 */
export function installLlmReplay(ctx: Context, config: ReplayConfig): () => void {
  const scripts = loadSessionScripts(config)
  // Live-session → its bound script + cursor. A new live session id claims the
  // next not-yet-bound script (scripts are in bind order); `nextScript` is the
  // index of the next unclaimed one.
  const bound = new Map<string, { entries: ReplayEntry[]; cursor: number }>()
  let nextScript = 0
  const ANON = '\0anon\0' // the key for a call that carries no sessionId
  const replay = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
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
  }
  const providers = config.providers ?? []
  if (providers.length > 0) {
    return ctx.llm.registerAdapter(providers.map(provider => provider.id), new ReplayAdapter(providers, replay))
  }
  return ctx.on('llm/stream', (options: GenerateOptions, _next) => replay(options))
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
  /** Optional replay-only provider catalog; absent or empty selects catch-all waterfall replay. */
  providers?: ReplayProviderConfig[]
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
    ...config.providers !== undefined ? { providers: config.providers } : {},
  })
}
