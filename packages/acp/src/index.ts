/**
 * The Agent Client Protocol (ACP) bridge: a client-driver / UI plugin that
 * exposes the harness agent as an ACP server over JSON-RPC stdio, so editors
 * (Zed and other ACP clients) can drive it. The structured analogue of the
 * readline `stdio-chat` plugin.
 *
 * This is NOT a loop change and NOT an ADR-0009 capability seam: it consumes
 * the existing `agent/*` event taxonomy, the `dsh-agent` create/resume factory,
 * and `dsh-session-persistence` (for `session/load`). It maps:
 *
 * - `initialize`     → protocol-version negotiation, text-only capabilities
 * - `session/new`    → `ctx.agents.create({ sessionId, meta:{cwd} })`
 * - `session/load`   → `ctx.agents.resume(...)` then replay the event log
 * - `session/prompt` → `agent.send()`, settle on the owning turn's end (a turn
 *                      that ends in `error` rejects the RPC)
 * - `session/cancel` → `agent.abort()` + settle the in-flight prompt
 *
 * Multi-session (RFC 011): N concurrent sessions per connection, each mapped to
 * its own `LoopAgent`. Sessions are keyed by id in `sessions` (forward) with an
 * `agent→sessionId` reverse map for O(1) demux of `agent/*` events; every
 * `session/event` and `agent/*` event is routed strictly to its owning session
 * record, so two sessions streaming at once never interleave their
 * `session/update` notifications. The `tools/execute` permission gate is
 * deferred — see the TODO(rfc010-permission-gate) note below.
 *
 * stdout is the protocol: this plugin must run in an example that loads NO
 * stdout logger (the console logger writes to stdout and would corrupt the
 * JSON-RPC frames). The guarantee is config-only — see the package README and
 * RFC 010 § Risks.
 *
 * @module @deepseek-ai/dsh-acp
 */

import type { Context } from 'cordis'
import { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import Schema from 'schemastery'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type ContentBlock as AcpContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type Stream,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Side-effect type import: declaration-merges `ctx.sessionPersistence` onto
// Context (the bridge injects it and reads `list()` for load cwd validation).
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  acpPromptToText,
  harnessBlockToAcpContent,
  promptHasUnsupportedContent,
  turnEndToStopReason,
} from './codec.ts'

export const name = 'acp'
// The bridge programs against the interface packages only (architecture rule:
// plugins never depend on dsh-agent-loop). `sessionPersistence` is required
// because `initialize` advertises `loadSession: true`.
export const inject = ['agents', 'sessions', 'sessionPersistence']

/**
 * Build an ACP "invalid params" error whose human detail rides in the message.
 * `RequestError.invalidParams(data, additionalMessage)` keeps the standard
 * "Invalid params" message and appends `additionalMessage`, so we pass the
 * detail as `additionalMessage` (and no structured `data`).
 */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/**
 * Build an ACP "internal error" whose human detail rides in the message. Used
 * to reject a `session/prompt` whose turn ended in failure: a plain `Error`
 * thrown from a method handler is flattened to a generic "Internal error" on
 * the wire, so we wrap the detail in the SDK's `RequestError.internalError`
 * (which appends `additionalMessage`) to surface *why* the turn failed.
 */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Plugin config: the agent template ACP sessions are created from. */
export interface AcpConfig {
  /** Model name for created agents (must have a registered adapter). */
  model?: string
  /** Per-agent system prompt. */
  systemPrompt?: string
  /** Agent/server name reported to the client in `initialize`. */
  agentName?: string
  /** Agent/server version reported to the client in `initialize`. */
  agentVersion?: string
  /**
   * Transport stream override. Production omits this (the plugin wires
   * `process.stdin`/`process.stdout` via `ndJsonStream`). Tests inject an
   * in-memory `Stream` (e.g. an `ndJsonStream` over a `Duplex` pair) to drive
   * the bridge without a subprocess. Not part of the schemastery `Config` —
   * it is a runtime-only seam, never set from a `cordis.yml`.
   */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  model: Schema.string(),
  systemPrompt: Schema.string(),
  agentName: Schema.string().default('deepseek-harness-acp'),
  agentVersion: Schema.string().default('0.0.1'),
})

/**
 * Per-session bridge state. One per live ACP session; held in the `sessions`
 * map keyed by id (RFC 011 multi-session).
 */
interface SessionRecord {
  sessionId: string
  agent: Agent
  /**
   * The in-flight `session/prompt`, or `undefined` when none is pending. A
   * prompt resolves with a {@link StopReason} or rejects with an Error (a
   * turn that ended in failure). Settled exactly once via {@link settlePrompt}.
   *
   * `turn` is the loop turn number this prompt owns, captured from the log's
   * `turn/start` after `send()`. Until then it is `undefined` (the turn has not
   * begun). Only a `turn/end` whose turn number equals `turn` settles the prompt
   * — so a *previous* prompt's late `turn/end` (e.g. an aborted turn whose end
   * arrives after the next prompt is already installed) can never settle the
   * wrong prompt. A direct cancel/dispose settle clears the whole in-flight slot,
   * so a later stale `turn/end` finds no pending prompt.
   *
   * `logWatermark` is the session log length at the moment the prompt was
   * installed (before `send()`). The settle-from-log fallback uses it to infer
   * the owning `turn/start` from the canonical log even when the live
   * `session/event` capture was starved (a peer listener that throws on
   * `turn/start` — see `settleFromLog`): the prompt owns the FIRST `turn/start`
   * appended at or after this watermark.
   */
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    turn: number | undefined
    logWatermark: number
  } | undefined
}

/**
 * Drive the in-flight prompt's settle from the harness event stream. A turn
 * can end three ways the bridge must all handle (AGENTS.md "honor cross-seam
 * contracts on BOTH sides"): the normal `agent/turn-end` event; a `turn/end`
 * session event WITHOUT the agent event (a boundary emit threw inside the loop,
 * which still appends `turn/end`); or the agent erroring/settling to idle. The
 * first of these to fire settles the prompt; `settle` is then cleared so the
 * others are no-ops (settle-exactly-once).
 */
export function apply(ctx: Context, config: AcpConfig): void {
  const agentName = config.agentName ?? 'deepseek-harness-acp'
  const agentVersion = config.agentVersion ?? '0.0.1'

  // Capture the injected services NOW, during apply(), while we are inside this
  // plugin's fiber (where `inject` grants access). The ACP method handlers run
  // LATER, from the AgentSideConnection's JSON-RPC read loop — a context that is
  // NOT this fiber's injection scope — so reading `ctx.agents` / `ctx.logger` /
  // `ctx.sessionPersistence` lazily inside a handler throws "cannot get property
  // … without inject". Resolving the references here and closing over them keeps
  // the handlers working regardless of which fiber later invokes them.
  const agents = ctx.agents
  const sessionPersistence = ctx.sessionPersistence
  const logger = ctx.logger

  // Live sessions keyed by id (RFC 011 multi-session), plus an agent→sessionId
  // reverse map so `agent/*` events (which carry only the Agent) demux in O(1).
  // The two stay in lockstep: a record is added to `sessions` and the agent to
  // `bySession` together, and removed together.
  const sessions = new Map<string, SessionRecord>()
  const bySession = new WeakMap<Agent, string>()
  // Session ids whose `session/load` is mid-`resume()` (the slot is reserved
  // before the async resume so a pipelined load/new for the SAME id can't create
  // two agents). Distinct ids load concurrently; a given id loads once at a time.
  const loadingIds = new Set<string>()
  // Set once the bridge has torn down (disposal or client disconnect). An async
  // `session/load` mid-`resume()` when teardown ran must observe this after its
  // await and NOT install a record (which would resurrect a live agent/listeners
  // after the bridge closed). Checked after every load await.
  let closed = false

  // Assigned at the bottom, before any agent event can fire (a session only
  // exists after `newSession`, which the client calls after construction), so
  // `notify` never observes it unset — no undefined guard needed.
  let conn: AgentSideConnection

  /**
   * Reject any RPC after the bridge has torn down. The `AgentSideConnection`
   * receive loop can outlive the plugin fiber — under an ACP-only HMR reload the
   * `agents`/`agent-loop` services stay up while the bridge's `ctx.on` listeners
   * and disposer are gone — so a late `session/new`/`load`/`prompt` could create
   * or drive an agent the bridge can no longer stream or settle. Every
   * state-affecting handler calls this first. (`initialize`/`authenticate` are
   * pure/stateless and may answer harmlessly.)
   */
  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  /** Resolve the live record for a sessionId, or throw an ACP error. */
  const requireSession = (sessionId: string): SessionRecord => {
    const rec = sessions.get(sessionId)
    if (rec === undefined) {
      throw invalidParams(`unknown session: ${sessionId}`)
    }
    return rec
  }

  /** Push a `session/update` notification, swallowing post-close rejections. */
  const notify = (notification: SessionNotification): void => {
    // sessionUpdate returns a promise; a closed connection rejects it. The
    // update is best-effort UI feed, never load-bearing for correctness, so a
    // throwing/rejecting send must not break the turn (the chunk is emitted
    // inside the model step — see AGENTS.md "contain callback exceptions").
    /* v8 ignore next 3 -- the rejection only fires on a stdout/connection write
       failure (closed pipe), which the in-memory test transport never induces;
       the swallow is a defensive best-effort guard like the loop's emit traps */
    void Promise.resolve(conn.sessionUpdate(notification)).catch((error: unknown) => {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    })
  }

  /** Settle the in-flight prompt with a stop reason, exactly once (no-op if none pending). */
  const settlePrompt = (rec: SessionRecord, reason: StopReason): void => {
    const inflight = rec.inflight
    if (inflight === undefined) return
    rec.inflight = undefined
    inflight.resolve(reason)
  }

  // --- Stream the harness event taxonomy to ACP session/update --------------

  // All content streaming AND the prompt settle flow through `session/event`,
  // the canonical log: every assistant/chunk and tool/call/result is logged, so
  // translating from the log makes live streaming and `session/load` replay
  // share the identical path (streamSessionEventUpdate). Both the owning-turn
  // capture and the settle key off the log's own `turn/start`/`turn/end` — NOT
  // the `agent/turn-start`/`agent/turn-end` EVENTS, which a throwing PEER
  // listener (cordis `emit` stops at the first throw) or a boundary-emit failure
  // can skip. `closeTurn` appends `turn/end` to the log unconditionally, and
  // `turn/start` is appended before any step runs, so within this one listener
  // we always see the prompt's turn-start (tag `inflight.turn`) then its
  // turn-end (settle). A `turn/end` settles the prompt ONLY when it is the
  // prompt's OWN turn (`inflight.turn === event.data.turn`) — a previous,
  // already-cancelled turn whose end arrives late is ignored (see
  // SessionRecord.inflight). A turn that ends `error` REJECTS the prompt (ACP
  // has no error stop reason); other reasons resolve via the codec. Demux
  // strictly by session id: a `session/event` is routed to its own record, so
  // two sessions streaming at once never cross-settle or interleave updates.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const rec = sessions.get(session.header.id)
    if (rec === undefined) return
    streamSessionEventUpdate(rec.sessionId, event, notify)
    const inflight = rec.inflight
    if (inflight === undefined) return
    if (event.type === 'turn/start') {
      // Tag the in-flight prompt with its owning turn — but ONLY a
      // `message`-triggered turn (the kind a `send()` prompt produces). A turn
      // a plugin opens between prompt-install and the prompt's own turn (an idle
      // `agent.inject()` writes a one-shot `injection`-triggered turn) must NOT
      // be mistaken for the prompt's turn, or its turn/end would settle the RPC
      // early. The first message turn at/after install owns the prompt
      // (`turn === undefined` guard); the loop batches queued messages into one
      // turn, so there is exactly one.
      if (inflight.turn === undefined && event.data.trigger.kind === 'message') {
        inflight.turn = event.data.turn
      }
      return
    }
    // Settle only on the OWNING turn's end.
    if (event.type !== 'turn/end' || inflight.turn !== event.data.turn) return
    rec.inflight = undefined
    const reason = event.data.reason
    if (reason.kind === 'error') {
      inflight.reject(internalError(`turn failed: ${reason.message}`))
    } else {
      inflight.resolve(turnEndToStopReason(reason))
    }
  })

  // Settle fallback: a `session/event` listener registered BEFORE ACP that
  // throws (on `turn/start` OR `turn/end`) would, via cordis `emit`'s
  // stop-on-throw, starve ACP's listener above — the prompt would hang or, if
  // only the turn number was missed, settle as the wrong outcome. So when the
  // agent settles to `idle` (or is disposed), reconcile against the canonical
  // log: determine the prompt's owning turn (the captured `turn`, or — if the
  // live capture was starved — the FIRST `turn/start` appended at/after the
  // install-time `logWatermark`), then settle from that turn's `turn/end`
  // (reject on error, resolve via codec), or `cancelled` if no owning turn ever
  // started. Never double-settles — clears `inflight` first.
  const settleFromLog = (rec: SessionRecord): void => {
    const inflight = rec.inflight
    if (inflight === undefined) return
    const events = rec.agent.session.events
    // The owning turn number: the captured one, or — if the live capture was
    // starved — inferred from the log as the first MESSAGE-triggered turn opened
    // at/after the watermark. The message-trigger filter matches the live
    // capture: a one-shot `injection` turn a plugin may open between
    // prompt-install and the prompt's turn is NOT the prompt's turn. Undefined
    // only if no message turn ever started for this prompt.
    const owningTurn = inflight.turn ?? events.slice(inflight.logWatermark).find(
      (e): e is Extract<SessionEvent, { type: 'turn/start' }> =>
        e.type === 'turn/start' && e.data.trigger.kind === 'message',
    )?.data.turn
    // The owning turn's end in the log. If `owningTurn` is undefined (no turn
    // ever started for this prompt — a torn-down-before-turn case that quiesce's
    // direct settle normally pre-empts), no `turn/end` matches (turn numbers are
    // >= 1) and `findLast` returns undefined, falling through to cancelled.
    const end = events.findLast(
      (e): e is Extract<SessionEvent, { type: 'turn/end' }> =>
        e.type === 'turn/end' && e.data.turn === owningTurn,
    )
    rec.inflight = undefined
    if (end === undefined) {
      // No owning turn / no clean turn/end (torn down mid-turn) → cancelled.
      inflight.resolve('cancelled')
      return
    }
    const reason = end.data.reason
    if (reason.kind === 'error') {
      inflight.reject(internalError(`turn failed: ${reason.message}`))
    } else {
      inflight.resolve(turnEndToStopReason(reason))
    }
  }

  // On a settle to idle/disposed, reconcile any still-pending prompt from the
  // log (covers a starved `session/event` listener — see settleFromLog). A mid-
  // step disposal that never appended a clean turn/end resolves `cancelled`.
  // Demux via the agent→sessionId reverse map.
  ctx.on('agent/status', (agent, status: AgentStatus) => {
    const sessionId = bySession.get(agent)
    if (sessionId === undefined) return
    const rec = sessions.get(sessionId)
    if (rec === undefined) return
    if (status === 'idle' || status === 'disposed') settleFromLog(rec)
  })

  // --- The ACP Agent method surface -----------------------------------------

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      initialize(params: InitializeRequest): Promise<InitializeResponse> {
        // Echo the client's version if we support it, else our own. We support
        // exactly PROTOCOL_VERSION; any other requested version negotiates
        // down to ours (the client disconnects if it can't speak it).
        const protocolVersion = params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION
        return Promise.resolve({
          protocolVersion,
          agentInfo: { name: agentName, version: agentVersion },
          agentCapabilities: {
            loadSession: true,
            // text-only: no image/audio/embeddedContext, no mcpCapabilities
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        // No auth methods advertised; nothing to do. Present because the SDK
        // Agent interface requires it.
        return Promise.resolve()
      },

      newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateWorkspaceParams(params)
        const sessionId = randomUUID()
        const agent = agents.create({
          agentId: sessionId,
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
        })
        bySession.set(agent, sessionId)
        sessions.set(sessionId, { sessionId, agent, inflight: undefined })
        return Promise.resolve({ sessionId })
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        assertOpen()
        if (sessions.has(params.sessionId) || loadingIds.has(params.sessionId)) {
          throw invalidParams(`session ${params.sessionId} is already loaded`)
        }
        validateWorkspaceParams(params)
        // Reserve THIS id's load slot BEFORE the await. Without it, two pipelined
        // loads for the same id could both pass the guard above while the first
        // resume() is pending, then both install a record and leak a second
        // agent. (Distinct ids load concurrently — the set is keyed by id.) The
        // slot is released in `finally` so a rejected load never wedges the id.
        loadingIds.add(params.sessionId)
        try {
          // Validate the PERSISTED cwd BEFORE resuming — `list()` is a
          // metadata-only read (no full-log parse) — so a mismatch rejects
          // without ever constructing/registering a live agent (which would
          // then leak in `ctx.agents`/`ctx.sessions` with no disposer here).
          // A session persisted in workspace A must not be loaded by a server
          // launched in workspace B: it would replay A's history while tools run
          // in B. (If the id is unknown to `list()`, fall through to resume,
          // which rejects with the backend's not-found error.)
          const meta = (await sessionPersistence.list()).find(m => m.id === params.sessionId)
          if (meta?.cwd !== undefined && meta.cwd !== process.cwd()) {
            throw invalidParams(
              `session was created in ${meta.cwd}, but the server's launch directory is ${process.cwd()}; honoring a different cwd is not yet supported — launch the server in the session's workspace`,
            )
          }
          const agent = await agents.resume({
            agentId: params.sessionId,
            resumeSessionId: params.sessionId,
            agentOptions: agentOptions(config),
          })
          // The bridge may have torn down (disposal / client disconnect) while
          // resume() was pending. Its listeners are gone, so installing a record
          // now would resurrect a live agent the bridge can no longer drive or
          // tear down. Bail: the just-resumed agent is reclaimed with the host
          // context (no per-agent disposer — TODO(rfc010-agent-disposal)).
          /* v8 ignore next 3 -- the in-memory test transport rejects the in-flight
             session/load request the instant it closes (before this post-await
             code runs), so the guard can't be hit in tests; it protects the real
             stdio path, where a closed pipe need not reject a mid-flight handler. */
          if (closed) {
            throw invalidParams('connection closed during session/load')
          }
          bySession.set(agent, params.sessionId)
          sessions.set(params.sessionId, { sessionId: params.sessionId, agent, inflight: undefined })
          // Replay the persisted event log to the client as session/update. Use
          // the raw event log (NOT deriveMessages, which drops assistant/chunk
          // and trace events): RFC 010's load contract reconstructs the streamed
          // turns — user prompts (user/message → user_message_chunk), assistant
          // text and reasoning (assistant/chunk), and tool calls/results.
          for (const event of agent.session.events) {
            streamSessionEventUpdate(params.sessionId, event, notify)
          }
          return {}
        } finally {
          loadingIds.delete(params.sessionId)
        }
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const rec = requireSession(params.sessionId)
        if (rec.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text prompt content is supported (text-only promptCapabilities); image/audio/resource blocks are rejected rather than silently dropped')
        }
        const text = acpPromptToText(params.prompt)
        if (text.trim().length === 0) {
          // Reject up front rather than calling send(): an empty prompt would
          // queue no work, no turn would start, and the RPC would hang forever
          // waiting for a settle that never comes.
          throw invalidParams('empty prompt')
        }
        // Install the in-flight slot BEFORE send() (send does not synchronously
        // flip status to running; the session/event listener records the turn
        // number and settle/rejects it). Capture the log length now as the
        // watermark: the settle-from-log fallback infers the owning turn/start
        // as the first one appended at/after it, surviving a starved live
        // capture. A turn that ends in error rejects this promise (the codec
        // never produces an error stop reason).
        const stopReason = await new Promise<StopReason>((resolve, reject) => {
          rec.inflight = { resolve, reject, turn: undefined, logWatermark: rec.agent.session.events.length }
          rec.agent.send([{ type: 'text', text }])
        })
        return { stopReason }
      },

      cancel(params: CancelNotification): Promise<void> {
        const rec = sessions.get(params.sessionId)
        if (rec === undefined) return Promise.resolve()
        // RFC 010: session/cancel maps to agent.abort(reason). This aborts a
        // RUNNING step (the turn ends 'aborted' → 'cancelled' via turn-end).
        // It aborts and settles ONLY this session's agent/prompt — a cancel in
        // one session never touches another's stream or pending prompt (RFC 011
        // isolation). It also settles the in-flight prompt as cancelled directly,
        // in case the abort lands in the pre-step window (queued-but-not-started)
        // where abort() has no AbortController to signal — see the README
        // TODO(rfc010-cancel-prestep): a not-yet-started queued turn may still
        // run to completion until a loop-level cancel lands. Best-effort abort
        // plus honest RPC/UI cancellation. A secondary consequence of that same
        // gap: because the loop batches all queued messages into one turn, a
        // prompt accepted right after a pre-step cancel can be merged into the
        // same turn as the cancelled one — that turn then carries both prompts'
        // text and the new prompt settles for it. Both are closed by the same
        // queue-aware loop cancel; the single-in-flight rule bounds the blast
        // radius to one extra prompt.
        rec.agent.abort('session/cancel')
        settlePrompt(rec, 'cancelled')
        return Promise.resolve()
      },
    }
  }

  // --- Connection lifecycle --------------------------------------------------

  // The transport stream. Production wires stdio (stdout carries the protocol);
  // tests inject an in-memory pipe pair via config.stream to drive the bridge
  // without a subprocess. ndJsonStream is the SDK's stdio framing helper. The
  // AgentSideConnection constructor synchronously invokes makeAgent (assigning
  // the outer `conn`), so `conn` is set before any agent method runs.
  /* v8 ignore next 4 -- production stdio wiring; tests always inject config.stream */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  /**
   * Tear ALL live sessions down to quiescence (AGENTS.md "dispose must reach
   * quiescence"): for each session settle any pending prompt `cancelled`, abort
   * the agent, and AWAIT it draining via the interface-level `whenIdle()` signal
   * (NOT `agent/status('disposed')`, which fires before the driver exits). The
   * agents drain in parallel. Idempotent — clears the `sessions` map first and
   * memoizes, so a second call (close racing dispose) is a no-op.
   * Shared by Cordis disposal AND client disconnect (`conn.closed`).
   *
   * Caveat (same window as TODO(rfc010-cancel-prestep)): if teardown lands in
   * the pre-step window — `agent.send()` queued a turn but the loop has not yet
   * flipped to `running` — `abort()` has no live `AbortController` to signal and
   * `whenIdle()` returns immediately (status is still `idle`), so that queued
   * turn may still start and run after teardown returns. Reaching true
   * quiescence in that window needs a queue-aware loop cancel primitive (a
   * loop-level change); the single-in-flight-per-session rule bounds the worst
   * case to one short queued turn per session.
   *
   * The agents are NOT individually disposed/unregistered here. The factory
   * (`ctx.agents.create`/`resume`) registers each via `AgentLoop.start`'s
   * `this.ctx.effect(...)`; because the factory is reached through this bridge's
   * traceable service proxy, that effect's `this.ctx` is the CALLER context (the
   * bridge fiber), so every registry entry is bound to the bridge fiber and is
   * reclaimed when the bridge fiber disposes (whole-context dispose, or an
   * ACP-only HMR `acpFiber.dispose()` — both unregister all the bridge's
   * agents). What this teardown path handles is a bare client disconnect, which
   * resolves `conn.closed` WITHOUT disposing the fiber: each live agent is
   * idled+aborted here but stays in `ctx.agents` until the fiber is disposed.
   * Since a reconnect spins up a fresh context, the lingering idle agents strand
   * no work. A per-agent disposal seam (unregister on disconnect) is a follow-up
   * (TODO(rfc010-agent-disposal)).
   */
  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    // Memoize: disposal and client-disconnect can both fire. The first call owns
    // the teardown; later callers await the SAME promise so `fiber.dispose()`
    // never returns before an in-flight close teardown has finished.
    if (quiescing !== undefined) return quiescing
    // Mark closed BEFORE draining: a `session/load` mid-`resume()` (no record
    // installed yet) must observe this after its await and refuse to install a
    // post-teardown record. Set even when there are no live sessions.
    closed = true
    const recs = [...sessions.values()]
    sessions.clear()
    if (recs.length === 0) return Promise.resolve()
    quiescing = (async () => {
      await Promise.all(recs.map(async (rec) => {
        settlePrompt(rec, 'cancelled')
        rec.agent.abort('disposed')
        await rec.agent.whenIdle()
      }))
    })()
    return quiescing
  }

  // Client disconnect: when the ACP transport closes (editor quits, pipe EOF),
  // the in-flight turn would otherwise keep running and its `session/update`
  // writes would be silently swallowed by `notify()`. Tear the session down so
  // a vanished client does not leave an orphaned running agent. `conn.closed`
  // rejects/resolves once; contain any teardown throw (nothing else can act on
  // it — the connection is already gone). The Cordis disposer below still runs
  // on normal shutdown and is idempotent with this.
  /* v8 ignore start -- the .catch arrow is a defensive guard: conn.closed
     settling rejected or quiesce() throwing on an already-closed connection is
     not reproducible through the in-memory test transport (it never severs
     mid-run), and there is nothing else to act on once the connection is gone —
     the swallow mirrors notify(). */
  void conn.closed.then(quiesce).catch((error: unknown) => {
    logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
  })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * Build per-agent options from the plugin config, omitting absent fields
 * (exactOptionalPropertyTypes: never assign `undefined` to an optional key).
 * Exported for unit coverage of both the present and absent branches.
 */
export function agentOptions(config: AcpConfig): { model?: string; systemPrompt?: string } {
  return {
    ...config.model !== undefined ? { model: config.model } : {},
    ...config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {},
  }
}

/**
 * Validate `session/new` params per the MVP contract: `cwd` absolute AND equal
 * to the server's launch directory (there is no path from session cwd to the
 * bash workdir yet — RFC 010 § Deferred — so the server must be launched in the
 * workspace root, and we error loudly rather than silently run tools in the
 * wrong directory); `additionalDirectories` empty (we cannot widen filesystem
 * scope yet, and silently ignoring them would desync the client's scope UI).
 */
/**
 * Validate the MVP `cwd`/`additionalDirectories` contract shared by
 * `session/new` and `session/load`: `cwd` must be absolute AND equal the
 * server's launch directory (there is no path from session cwd to the bash
 * workdir yet — RFC 010 § Deferred — so the server must be launched in the
 * workspace root, and we error loudly rather than silently run tools in the
 * wrong directory); `additionalDirectories` must be empty (we cannot widen
 * filesystem scope yet, and silently ignoring it would desync the client's
 * scope UI). Both request shapes carry `cwd: string` and
 * `additionalDirectories?: string[]`, so one validator covers both.
 */
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] }): void {
  if (!isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  }
  if (params.cwd !== process.cwd()) {
    throw invalidParams(
      `cwd must equal the server's launch directory (${process.cwd()}); honoring an arbitrary cwd is not yet supported — launch the server in the workspace root`,
    )
  }
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported in this MVP')
  }
}

/**
 * Translate a single harness {@link SessionEvent} into the `session/update`
 * notification(s) it produces, pushing each via `notify`. Shared by live
 * streaming (`session/event`) and `session/load` replay so both paths emit an
 * identical update stream from the same event log.
 *
 * - `assistant/chunk` text-delta/reasoning-delta → message/thought chunks
 * - `user/message` → `user_message_chunk` (text blocks) — so a `session/load`
 *   replay reconstructs the USER side of each turn, not just the agent's
 * - `tool/call`   → `tool_call` (pending)
 * - `tool/result` → `tool_call_update` (completed/failed)
 *
 * Other event types (turn/step boundaries, context/message, usage, …) produce
 * no client update.
 */
export function streamSessionEventUpdate(
  sessionId: string,
  event: SessionEvent,
  notify: (notification: SessionNotification) => void,
): void {
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        notify({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } } })
      } else if (chunk.type === 'reasoning-delta') {
        notify({ sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } } })
      }
      return
    }
    case 'user/message': {
      // Replay the user's prompt so a loaded session shows both sides of each
      // turn. Only text blocks carry inline content the bridge surfaces (the
      // prompt path is text-only); other block kinds produce no chunk.
      for (const block of event.data.content) {
        const content = harnessBlockToAcpContent(block)
        if (content !== undefined) {
          notify({ sessionId, update: { sessionUpdate: 'user_message_chunk', content } })
        }
      }
      return
    }
    case 'tool/call': {
      notify({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: event.data.callId,
          title: event.data.name,
          kind: toolKindFor(event.data.name),
          status: 'in_progress',
          rawInput: parseToolArguments(event.data.arguments),
        },
      })
      return
    }
    case 'tool/result': {
      notify({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.data.callId,
          status: event.data.isError ? 'failed' : 'completed',
          content: toolResultContent(event.data.content),
        },
      })
      return
    }
    // turn/step boundaries, context/message, steering, usage, error,
    // assistant/message — no direct ACP client update.
    default:
      return
  }
}

/** Map a harness tool name to an ACP ToolKind (best-effort; default `other`). */
function toolKindFor(name: string): 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other' {
  if (name === 'bash' || name === 'bash_output' || name === 'bash_kill') return 'execute'
  if (name === 'read' || name.startsWith('read')) return 'read'
  if (name === 'write' || name === 'edit' || name.startsWith('edit')) return 'edit'
  return 'other'
}

/** Parse a tool-call arguments JSON string for `rawInput`; raw string on failure. */
function parseToolArguments(args: string): unknown {
  try {
    return args ? JSON.parse(args) : {}
  } catch {
    // The model produced non-JSON arguments; surface the raw string rather
    // than dropping it. (The harness tool layer handles validation; here we
    // only feed the client's tool-call UI.)
    return args
  }
}

/** Map harness tool-result content blocks to ACP tool-call content (text only). */
function toolResultContent(blocks: ContentBlock[]): { type: 'content'; content: AcpContentBlock }[] {
  const out: { type: 'content'; content: AcpContentBlock }[] = []
  for (const block of blocks) {
    const content = harnessBlockToAcpContent(block)
    if (content !== undefined) out.push({ type: 'content', content })
  }
  return out
}
