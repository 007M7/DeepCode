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
 * - `session/cancel` → `agent.cancel()` (the queue-aware cancel: aborts a
 *                      running step, clears queued + steering work, and drops a
 *                      turn about to start) + settle the in-flight prompt
 *
 * Multi-session (RFC 011): N concurrent sessions per connection, each mapped to
 * its own `ReactLoopAgent`. Sessions are keyed by id in `sessions` (forward) with an
 * `agent→sessionId` reverse map for O(1) demux of `agent/*` events; every
 * `session/event` and `agent/*` event is routed strictly to its owning session
 * record, so two sessions streaming at once never interleave their
 * `session/update` notifications. The `tools/pre-execute` permission gate is
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
import { isAbsolute, relative as relativePath, resolve as resolvePath, sep as pathSep } from 'node:path'
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
  type Plan,
  type PlanEntry,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type Stream,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertNever, CallId } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TodoItem, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ToolCallKind, ToolCallView, ToolRegistry, ToolResultView, TerminalResultView } from '@deepseek-ai/dsh-tools'
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
// because `initialize` advertises `loadSession: true`. `tools` lets a tool own
// how its calls render (`presentCall`/`presentResult`); the bridge looks up the
// definition by name and falls back to a generic presentation when absent.
export const inject = ['agents', 'sessions', 'sessionPersistence', 'tools']

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

function sameWorkspaceCwd(left: string, right: string): boolean {
  return resolvePath(left) === resolvePath(right)
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
  sessionId: SessionId
  agent: Agent
  /**
   * The owned-agent disposer (from the {@link AgentHandle} the factory returned).
   * Teardown calls it to unregister this ONE agent, stop its loop, await
   * quiescence, and remove its session — instead of leaving it for the bridge
   * fiber to reclaim.
   */
  dispose: () => Promise<void>
  /**
   * Resolves tool-owned presentation for THIS session's tool calls and remembers
   * each in-flight call's `(name, args)` so the matching `tool/result` can find
   * its tool. Per-session so two concurrent sessions never cross their in-flight
   * tool state.
   */
  presenter: ToolPresenter
  /**
   * Whether THIS session renders shell tools as terminal cards — snapshotted
   * from the client's `_meta.terminal_output` capability at session creation
   * (`session/new`/`session/load`), NOT re-read live. A capability snapshot per
   * session means the `tool_call` (which registers the terminal) and the matching
   * `tool_call_update` (which streams its output) ALWAYS agree, even if a later
   * `initialize` mutates the connection-level capability between them — otherwise
   * a re-`initialize` mid-call could orphan a `terminal_output` (call non-terminal,
   * result terminal) or clobber the card (call terminal, result non-terminal).
   */
  terminalEnabled: boolean
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
 * Drive the in-flight prompt's settle from the harness event stream. The bridge
 * settles off the durable log: the `turn/end` session event on the
 * `session/event` feed for the prompt's own turn, with the agent
 * erroring/settling to idle as a fallback (AGENTS.md "honor cross-seam contracts
 * on BOTH sides") for the case where a throwing peer `session/event` listener
 * starved the bridge's listener before it saw the boundary. The first of these
 * to fire settles the prompt; `settle` is then cleared so the others are no-ops
 * (settle-exactly-once).
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // TODO(double-default): these literals duplicate the Config schema defaults
  // (`agentName`/`agentVersion` `.default(...)` above). The Loader applies the
  // schema before apply() runs, so the `??` only fires for direct-apply unit
  // tests. Pick one home for the default to avoid drift.
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
  const tools = ctx.tools
  // A new ToolPresenter per session (and a throwaway per load replay), each given
  // this warn sink so a throwing tool presenter is logged, not propagated.
  const makePresenter = (): ToolPresenter => new ToolPresenter(tools, (message) => { logger.warn(message) })

  // Live sessions keyed by id (RFC 011 multi-session), plus an agent→sessionId
  // reverse map so `agent/*` events (which carry only the Agent) demux in O(1).
  // The two stay in lockstep: a record is added to `sessions` and the agent to
  // `bySession` together, and removed together.
  const sessions = new Map<SessionId, SessionRecord>()
  const bySession = new WeakMap<Agent, SessionId>()
  // Session ids whose `session/load` is mid-`resume()` (the slot is reserved
  // before the async resume so a pipelined load/new for the SAME id can't create
  // two agents). Distinct ids load concurrently; a given id loads once at a time.
  const loadingIds = new Set<SessionId>()
  // Set once the bridge has torn down (disposal or client disconnect). An async
  // `session/load` mid-`resume()` when teardown ran must observe this after its
  // await and NOT install a record (which would resurrect a live agent/listeners
  // after the bridge closed). Checked after every load await.
  let closed = false
  // Whether the client advertised the Zed `_meta.terminal_output` capability in
  // `initialize`. When true, a tool's terminal presentation is rendered as a
  // terminal card (content + `_meta.terminal_*`); when false, the bridge uses
  // the tool's text fallback. Set once in `initialize`, read on every tool event.
  let terminalOutputCap = false

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
  const requireSession = (sessionId: SessionId): SessionRecord => {
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

  /** Apply the single ACP prompt-settlement mapping for a completed turn. */
  const settleFromTurnEnd = (
    inflight: NonNullable<SessionRecord['inflight']>,
    reason: TurnEndReason,
  ): void => {
    if (reason.kind === 'error') {
      inflight.reject(internalError(`turn failed: ${reason.message}`))
    } else {
      inflight.resolve(turnEndToStopReason(reason))
    }
  }

  // --- Stream the harness event taxonomy to ACP session/update --------------

  // All content streaming AND the prompt settle flow through `session/event`,
  // the canonical log: every assistant/chunk and tool/call/result is logged, so
  // translating from the log makes live streaming and `session/load` replay
  // share the identical path (streamSessionEventUpdate). Both the owning-turn
  // capture and the settle key off the log's own `turn/start`/`turn/end` — the
  // durable boundary events (there is no agent/* turn mirror). `closeTurn`
  // appends `turn/end` to the log unconditionally, and `turn/start` is appended
  // before any step runs, so within this one listener we always see the
  // prompt's turn-start (tag `inflight.turn`) then its turn-end (settle). A
  // `turn/end` settles the prompt ONLY when it is the prompt's OWN turn
  // (`inflight.turn === event.data.turn`) — a previous, already-cancelled turn
  // whose end arrives late is ignored (see
  // SessionRecord.inflight). A turn that ends `error` REJECTS the prompt (ACP
  // has no error stop reason); other reasons resolve via the codec. Demux
  // strictly by session id: a `session/event` is routed to its own record, so
  // two sessions streaming at once never cross-settle or interleave updates.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const rec = sessions.get(session.header.id)
    if (rec === undefined) return
    streamSessionEventUpdate(rec.sessionId, event, notify, rec.presenter, {
      enabled: rec.terminalEnabled,
      cwd: session.header.cwd,
    }, { includeUserMessages: false })
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
    settleFromTurnEnd(inflight, event.data.reason)
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
    settleFromTurnEnd(inflight, end.data.reason)
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
        // Remember the Zed terminal-output `_meta` capability: when set, bash and
        // other shell tools render as a terminal card (see streamSessionEventUpdate
        // + the terminal-rendering RFC). `_meta` is `{[k]: unknown} | null`, so
        // narrow defensively to a strict boolean true.
        terminalOutputCap = params.clientCapabilities?._meta?.['terminal_output'] === true
        return Promise.resolve({
          protocolVersion,
          agentInfo: { name: agentName, version: agentVersion },
          agentCapabilities: {
            loadSession: true,
            // Baseline prompt blocks only: text plus resource_link rendered as
            // text. No image/audio/embeddedContext, no mcpCapabilities.
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
        validateMcpServers(params)
        const sessionId = SessionId(randomUUID())
        const handle = agents.create({
          agentId: AgentId(sessionId),
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
        })
        bySession.set(handle.agent, sessionId)
        sessions.set(sessionId, {
          sessionId,
          agent: handle.agent,
          dispose: () => handle.dispose(),
          presenter: makePresenter(),
          terminalEnabled: terminalOutputCap,
          inflight: undefined,
        })
        return Promise.resolve({ sessionId })
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        assertOpen()
        // The wire `params.sessionId` is a raw protocol string; brand it once at
        // this entry so the session collections and the resume factory see a SessionId.
        const sessionId = SessionId(params.sessionId)
        if (sessions.has(sessionId) || loadingIds.has(sessionId)) {
          throw invalidParams(`session ${sessionId} is already loaded`)
        }
        validateWorkspaceParams(params)
        validateMcpServers(params)
        // Reserve THIS id's load slot BEFORE the await. Without it, two pipelined
        // loads for the same id could both pass the guard above while the first
        // resume() is pending, then both install a record and leak a second
        // agent. (Distinct ids load concurrently — the set is keyed by id.) The
        // slot is released in `finally` so a rejected load never wedges the id.
        loadingIds.add(sessionId)
        try {
          // Validate the PERSISTED cwd BEFORE resuming — `list()` is a
          // metadata-only read (no full-log parse), so this rejects a session we
          // can't honor WITHOUT ever constructing/registering an agent (a
          // post-resume reject would leak the registered agent — cancel() does not
          // unregister it — and wedge the id against re-load). The session's bash
          // workdir is derived from its persisted `header.cwd` and the request
          // `cwd` does NOT override it (resume takes no cwd), so a session with no
          // absolute persisted cwd would silently run bash in the SERVER's launch
          // dir, not the client's workspace. A session created by this bridge
          // always has a cwd (session/new requires it); reject the rest loudly.
          // (An id unknown to `list()` falls through to resume, which rejects with
          // the backend's not-found error.)
          const meta = (await sessionPersistence.list()).find(m => m.id === sessionId)
          if (meta !== undefined) {
            const persistedCwd = meta.cwd
            if (persistedCwd === undefined || !isAbsolute(persistedCwd)) {
              throw invalidParams(
                `session ${sessionId} has no absolute persisted cwd; cannot determine its workspace (it predates per-session cwd, or was created without one)`,
              )
            }
            if (!sameWorkspaceCwd(persistedCwd, params.cwd)) {
              throw invalidParams(`session ${sessionId} cwd mismatch: persisted ${persistedCwd}, requested ${params.cwd}`)
            }
          }
          const handle = await agents.resume({
            agentId: AgentId(sessionId),
            resumeSessionId: sessionId,
            agentOptions: agentOptions(config),
          })
          // The bridge may have torn down (disposal / client disconnect) while
          // resume() was pending. Its listeners are gone, so installing a record
          // now would resurrect a live agent the bridge can no longer drive. Bail —
          // and tear down the just-resumed agent (unregister + stop + remove its
          // session) before throwing, so it does not leak: it has no SessionRecord,
          // so quiesce() would never see it.
          /* v8 ignore next 4 -- the in-memory test transport rejects the in-flight
             session/load request the instant it closes (before this post-await
             code runs), so the guard can't be hit in tests; it protects the real
             stdio path, where a closed pipe need not reject a mid-flight handler. */
          if (closed) {
            await handle.dispose()
            throw invalidParams('connection closed during session/load')
          }
          const agent = handle.agent
          bySession.set(agent, sessionId)
          // Snapshot the terminal capability ONCE for this session (used by both
          // the replay below and the post-load live stream) so a later
          // `initialize` can't desync the call/result of a tool card.
          const terminalEnabled = terminalOutputCap
          const record: SessionRecord = {
            sessionId,
            agent,
            dispose: () => handle.dispose(),
            presenter: makePresenter(),
            terminalEnabled,
            inflight: undefined,
          }
          sessions.set(sessionId, record)
          // Replay the persisted event log to the client as session/update. Use
          // the raw event log (NOT deriveMessages, which drops assistant/chunk
          // and trace events): RFC 010's load contract reconstructs the streamed
          // turns — user prompts (user/message → user_message_chunk), assistant
          // text and reasoning (assistant/chunk), and tool calls/results.
          //
          // Replay through a THROWAWAY presenter, NOT `record.presenter`: a
          // historical turn that was interrupted mid-tool (a `tool/call` with no
          // matching `tool/result` in the persisted log) would otherwise leave a
          // stale in-flight entry on the live presenter, which then serves all
          // future live events for this session. The throwaway pairs call→result
          // as the log replays in order (same as live) and is discarded after,
          // so the record's presenter starts clean for the post-load live stream.
          const replayPresenter = makePresenter()
          const replayTerminal: TerminalRendering = {
            enabled: terminalEnabled,
            cwd: agent.session.header.cwd,
          }
          for (const event of agent.session.events) {
            streamSessionEventUpdate(sessionId, event, notify, replayPresenter, replayTerminal)
          }
          return {}
        } finally {
          loadingIds.delete(sessionId)
        }
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const rec = requireSession(SessionId(params.sessionId))
        if (rec.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text and resource_link prompt content is supported; image/audio/embedded resource blocks are rejected rather than silently dropped')
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
        const rec = sessions.get(SessionId(params.sessionId))
        if (rec === undefined) return Promise.resolve()
        // session/cancel maps to the queue-aware agent.cancel(reason): it aborts
        // a RUNNING step, clears the queued + steering FIFOs, and drops a
        // turn that is about to start (the pre-step window) — so a queued-but-
        // not-yet-started prompt never runs, and a prompt accepted right after
        // cannot be batched into the cancelled turn. Scoped to THIS session's
        // agent — a cancel in one session never touches another's stream or
        // pending prompt (RFC 011 isolation). We ALSO settle the in-flight prompt
        // as cancelled directly here: do NOT rely on the resulting turn/end to
        // settle it, because cancel() may drop the turn before any turn/end is
        // emitted, and removing this direct settle would move the RPC's
        // resolution onto the settleFromLog/agent-status path, changing its
        // timing.
        rec.agent.cancel('session/cancel')
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
   * quiescence"): for each session settle any pending prompt `cancelled`, then
   * run that session's {@link AgentHandle} `dispose()` — which stops the loop
   * (sets `disposed`, aborts the in-flight step), AWAITS the loop's exit (the
   * final `turn/end` + `session/flush` are captured while `onAppend` is still
   * attached), unregisters the agent, and removes its session from the store.
   * The per-session disposes run in parallel. Idempotent — clears the `sessions`
   * map first and memoizes, so a second call (close racing dispose) is a no-op.
   * Shared by Cordis disposal AND client disconnect (`conn.closed`).
   *
   * Per-agent disposal closes the former pre-step best-effort window — but via
   * the DISPOSED path, not `cancel()`: the start-disposer resolves `handle.disposed`,
   * which wakes the parked loop, and `isDisposed()` breaks the loop before a
   * queued-but-not-yet-running turn can start (a turn cut off mid-flight ends
   * with reason `disposed`, not `aborted`). A bare client disconnect (resolves
   * `conn.closed` WITHOUT disposing the fiber) thus leaves NO registered agent
   * and NO session-store entry — not an idled-but-still-registered one. When the
   * fiber IS disposed (whole-context or an ACP-only HMR
   * `acpFiber.dispose()`), this same memoized teardown runs first; the factory's
   * register+start+session effects are ALSO bound to the bridge fiber (the
   * factory is reached through this bridge's traceable service proxy, so
   * `AgentLoop.start`'s `this.ctx.effect(...)` binds to the CALLER context — the
   * bridge fiber), so any agent this path did not reach is still reclaimed by
   * fiber disposal.
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
        // Per-agent dispose (the AgentHandle disposer): unregister this agent,
        // stop its loop (sets disposed + aborts the in-flight step), await
        // quiescence (the loop exit + final flush), and remove its session — so
        // a bare client disconnect leaves NO registered agent and NO
        // session-store entry, not just an idled-but-still-registered one.
        await rec.dispose()
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
 * Validate the `cwd`/`additionalDirectories` contract shared by `session/new`
 * and `session/load`: `cwd` must be absolute (a relative path would be ambiguous
 * as a workspace root). The persisted-cwd equality check for `session/load`
 * happens after the metadata lookup; this validator only enforces request shape:
 *  - `session/new`: the validated `cwd` becomes the session's `SessionHeader.cwd`
 *    (via `agents.create({meta:{cwd}})`) and thus the default bash workdir.
 *  - `session/load`: the request `cwd` must be absolute AND must match the
 *    PERSISTED `header.cwd`, which stays authoritative for the bash workdir —
 *    the request cwd does not override it.
 * Any absolute path is accepted (the per-session cwd flows to the bash executor
 * — see `dsh-tool-bash`), so the server no longer has to launch in the
 * workspace. `additionalDirectories` must still be empty: widening the
 * tool/filesystem scope beyond the single cwd is a separate, unimplemented
 * concern (a sandbox seam), and silently ignoring extra roots would desync the
 * client's filesystem-scope UI. Both request shapes carry `cwd: string` and
 * `additionalDirectories?: string[]`, so one validator covers both.
 */
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] }): void {
  if (!isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  }
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported in this MVP')
  }
}

function validateMcpServers(params: { mcpServers?: unknown[] }): void {
  if (params.mcpServers !== undefined && params.mcpServers.length > 0) {
    throw invalidParams('mcpServers is not supported in this MVP')
  }
}

/**
 * Translate a single harness {@link SessionEvent} into the `session/update`
 * notification(s) it produces, pushing each via `notify`. Shared by live
 * streaming (`session/event`) and `session/load` replay so both paths emit an
 * identical update stream from the same event log.
 *
 * - `assistant/chunk` text-delta/reasoning-delta → message/thought chunks
 * - `user/message` → `user_message_chunk` during load replay only — so a
 *   loaded transcript reconstructs the USER side of each turn without echoing
 *   a live `session/prompt` back to the client
 * - `tool/call`   → `tool_call` (pending)
 * - `tool/result` → `tool_call_update` (completed/failed)
 *
 * Tool-call presentation (title/kind/rawInput, and the completed-state content)
 * is owned by each TOOL via `presentCall`/`presentResult` — the bridge never
 * special-cases tool names. `presenter` resolves those from the tool registry
 * and remembers each call's `(name, args)` so the completed `tool/result` (which
 * carries neither) can find its tool. A {@link nullToolPresenter} gives the
 * generic fallback (title = tool name, raw args as input) when no registry is
 * available (e.g. pure translator tests).
 *
 * Other event types (turn/step boundaries, context/message, …) produce
 * no client update.
 */
export function streamSessionEventUpdate(
  sessionId: SessionId,
  event: SessionEvent,
  notify: (notification: SessionNotification) => void,
  presenter: Pick<ToolPresenter, 'call' | 'result'> = nullToolPresenter,
  terminal: TerminalRendering = noTerminalRendering,
  options: { includeUserMessages?: boolean } = {},
): void {
  const includeUserMessages = options.includeUserMessages ?? true
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
      if (!includeUserMessages) return
      // Replay the user's prompt so a loaded session shows both sides of each
      // turn. Live prompt turns suppress this path to avoid duplicating what
      // the client just sent.
      for (const block of event.data.content) {
        const content = harnessBlockToAcpContent(block)
        if (content !== undefined) {
          notify({ sessionId, update: { sessionUpdate: 'user_message_chunk', content } })
        }
      }
      return
    }
    case 'tool/call': {
      const view = presenter.call(event.data.callId, event.data.name, event.data.arguments)
      notify({ sessionId, update: toolCallUpdate(event.data.callId, view, terminal) })
      return
    }
    case 'tool/result': {
      const view = presenter.result(event.data.callId, event.data.content, event.data.isError, event.data.meta)
      notify({ sessionId, update: toolResultUpdate(event.data.callId, view, event.data.isError, terminal) })
      return
    }
    case 'todo/write': {
      notify({ sessionId, update: { sessionUpdate: 'plan', ...todosToPlan(event.data.todos) } })
      return
    }
    // turn/step boundaries, context/message, steering,
    // assistant/message — no direct ACP client update.
    default:
      return
  }
}

/**
 * Map a harness todo list to an ACP `plan` body. ACP's `PlanEntry` requires
 * `content` + `priority` + `status`, but a {@link TodoItem} carries no priority,
 * so synthesize a constant `'medium'` on every entry; `status` maps 1:1 (the
 * harness status triple IS `PlanEntryStatus`). The ACP client REPLACES its whole
 * plan on each `plan` update, matching the harness's whole-list-replace
 * semantics, so no per-entry diffing is needed.
 */
export function todosToPlan(todos: TodoItem[]): Plan {
  return { entries: todos.map((todo): PlanEntry => ({ content: todo.content, priority: 'medium', status: todo.status })) }
}

/**
 * Per-connection terminal-rendering context threaded into
 * {@link streamSessionEventUpdate}: whether the client advertised the
 * `_meta.terminal_output` capability, and the session's workspace cwd (the
 * default terminal-card header when a tool doesn't supply its own). Kept out of
 * the pure translator's required params so the no-capability / no-presenter
 * tests stay terse.
 */
export interface TerminalRendering {
  enabled: boolean
  /** The session workspace cwd (terminal-card header default); `undefined` when the session has none. */
  cwd: string | undefined
}

/** Default: terminal rendering off (the ` ```console ` text fallback path). */
const noTerminalRendering: TerminalRendering = { enabled: false, cwd: undefined }

/**
 * Resolves tool-owned presentation for a session's tool-call events. A tool
 * declares `presentCall`/`presentResult` (see `dsh-tools`) returning a
 * `card`-tagged {@link ToolCallView}/{@link ToolResultView}; this looks them up
 * by name in the registry and applies a generic fallback when a tool defines
 * neither. The returned view is what {@link streamSessionEventUpdate} switches on.
 *
 * The `tool/result` session event does NOT carry the tool name or args — so to
 * call a tool's `presentResult` (which needs both), the presenter remembers each
 * `tool/call`'s `{ name, args, card }` keyed by callId and looks it up on the
 * matching result. The map is bridge-LOCAL (not a change to the event schema or a
 * core service): one presenter per live session
 * (and a throwaway per `session/load` replay), and each entry is removed when its
 * result arrives. In the normal loop a `tool/call` is always followed by a
 * `tool/result` (the registry turns even a thrown tool into an isError result),
 * so the map holds only currently-in-flight calls. The one exception is a step
 * torn down mid-tool (an abort between `tool/call` and `tool/result`), which can
 * leave a single stale entry per such call; this is bounded by the session
 * lifetime (the whole presenter is dropped on teardown) and never affects
 * correctness — a later result for a different callId is unaffected, and the
 * stale entry's only cost is one map slot until the session ends.
 */
export class ToolPresenter {
  private readonly pending = new Map<CallId, { name: string; args: unknown; card: ToolCallView['card'] }>()

  /**
   * @param tools the registry to resolve tool definitions by name.
   * @param onError invoked when a tool's `presentCall`/`presentResult` THROWS;
   *   the presenter swallows the error and falls back to the generic
   *   presentation so a buggy display callback can never fail a live turn or a
   *   `session/load` replay (AGENTS.md "contain callback exceptions at the
   *   boundary"). Defaults to a no-op for callers that don't supply a logger.
   */
  constructor(
    private readonly tools: Pick<ToolRegistry, 'get'>,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** Pending-state render intent for a `tool/call`; remembers `(name, args, card)` for the matching result. */
  call(callId: CallId, name: string, argsJson: string): ToolCallView {
    const args = parseToolArguments(argsJson)
    let present: ToolCallView | undefined
    try {
      present = this.tools.get(name)?.presentCall?.(args)
    } catch (error: unknown) {
      // A throwing presentCall must not break streaming: log and fall back.
      this.onError(`acp: tool "${name}" presentCall threw, using generic presentation: ${String(error)}`)
      present = undefined
    }
    // No tool-owned presentation: fall back to the tool name as the title and the
    // full parsed args as the raw input (the generic card).
    const view: ToolCallView = present ?? { card: 'generic', title: name, kind: toolKindFor(name), rawInput: args }
    this.pending.set(callId, { name, args, card: view.card })
    return view
  }

  /** Completed-state render intent for a `tool/result`; consumes the remembered `(name, args, card)`. */
  result(callId: CallId, content: ContentBlock[], isError: boolean, meta?: unknown): ToolResultView {
    const call = this.pending.get(callId)
    this.pending.delete(callId)
    // No remembered call (unknown/late callId) → nothing to present from; raw content.
    if (call === undefined) return { card: 'generic', content }
    let present: ToolResultView | undefined
    try {
      present = this.tools.get(call.name)?.presentResult?.(call.args, { content, isError, ...meta !== undefined ? { meta } : {} })
    } catch (error: unknown) {
      // A throwing presentResult must not break streaming/replay: log + fall back.
      this.onError(`acp: tool "${call.name}" presentResult threw, using raw result: ${String(error)}`)
      present = undefined
    }
    if (present === undefined) return { card: 'generic', content }
    // Orphan guard: only honor a `terminal` result when the PENDING call was a
    // terminal. A result-only terminal with no matching call-side terminal would
    // orphan `_meta.terminal_output` to a terminal Zed never made — drop it back
    // to the raw content.
    if (present.card === 'terminal' && call.card !== 'terminal') return { card: 'generic', content }
    // A generic result that reformats no content keeps the RAW result content
    // (the tool replaced only the title); fill it so the card is never blanked.
    if (present.card === 'generic' && present.content === undefined) return { ...present, content }
    return present
  }
}

/**
 * The no-op presenter used when no tool registry is available (e.g. the pure
 * translator tests): every tool gets the generic fallback presentation, and
 * results pass their raw content through unchanged.
 */
export const nullToolPresenter: Pick<ToolPresenter, 'call' | 'result'> = {
  call: (_callId, name, argsJson) => ({ card: 'generic', title: name, kind: toolKindFor(name), rawInput: parseToolArguments(argsJson) }),
  result: (_callId, content) => ({ card: 'generic', content }),
}

/** Map a harness tool name to an ACP ToolKind (best-effort; default `other`). */
function toolKindFor(name: string): ToolCallKind {
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

/** The `session/update` payload for a `tool_call` / `tool_call_update`. */
type ToolCallSessionUpdate = SessionNotification['update']

/** An ACP tool-call content block (a text/image `content`, a `diff`, or a `terminal`). */
type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

/**
 * Relativize a file card's TITLE path against the session workspace cwd, so a
 * card reads `Read src/foo.ts` rather than `/abs/proj/src/foo.ts` — matching the
 * reference ACP adapter's `toDisplayPath`. Only the TITLE is relativized; the
 * card's `locations`/`diff` paths stay RAW (the editor opens the real path). The
 * pure tool presenter can't see the session cwd, so this happens here where the
 * bridge knows it. The rewrite is an exact substring replace of the known raw
 * path (a card carries the same path in `locations[0]`/`diffs[0]`), never a
 * heuristic. A path outside the workspace, or an absent/relative session cwd, is
 * left unchanged.
 */
function displayTitle(title: string, rawPath: string | undefined, sessionCwd: string | undefined): string {
  if (rawPath === undefined || sessionCwd === undefined || !isAbsolute(rawPath) || !isAbsolute(sessionCwd)) return title
  const rel = relativePath(sessionCwd, rawPath)
  // Only relativize a target that stays INSIDE the workspace. `relative` prefixes
  // a `..` SEGMENT for a target above the cwd — test for the segment (`..` alone
  // or `..<sep>…`), NOT a bare `..` char prefix, so a sibling like `..cache/x`
  // (a real in-workspace name) still relativizes. Never relativize to the empty
  // string (rawPath === cwd — a non-file target).
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${pathSep}`)) return title
  return title.split(rawPath).join(rel)
}

/**
 * Resolve the terminal card's header cwd. A `TerminalCallView.cwd` (a model
 * `workdir`) wins when ABSOLUTE; a RELATIVE one resolves against the session cwd
 * (matching how `dsh-tool-bash` resolves a relative workdir for execution, so the
 * header matches where the command actually ran); when the view gives no cwd, the
 * session workspace cwd is the default. Returns `undefined` only when neither the
 * view nor the session supplies one (Zed then shows "current directory").
 */
function terminalCwd(viewCwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (viewCwd === undefined) return sessionCwd
  if (isAbsolute(viewCwd)) return viewCwd
  return sessionCwd !== undefined ? resolvePath(sessionCwd, viewCwd) : viewCwd
}

/**
 * Build the `tool_call` (pending) `session/update` from a tool's render intent.
 * Switches on `view.card`: a `generic` card maps title/kind/rawInput/content/
 * locations; a `diff` card emits `{ type: 'diff' }` content blocks (the editor's
 * inline diff) plus follow-along locations; a `terminal` card renders as a
 * terminal when the client is capable (a `terminal` content block + the
 * `_meta.terminal_info` cwd header) and otherwise falls back to a generic execute
 * card whose body is the description. File-card titles are relativized against the
 * session cwd (see {@link displayTitle}).
 */
function toolCallUpdate(callId: CallId, view: ToolCallView, terminal: TerminalRendering): ToolCallSessionUpdate {
  switch (view.card) {
    case 'generic':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        // Relativize the title against the session cwd when the card carries a
        // file location (a read/file card); a location-less card (bash, todo)
        // has no path to relativize, so the title is used as-is.
        title: displayTitle(view.title, view.locations?.[0]?.path, terminal.cwd),
        kind: view.kind ?? 'other',
        status: 'in_progress',
        ...view.rawInput !== undefined ? { rawInput: view.rawInput } : {},
        ...view.locations !== undefined ? { locations: view.locations } : {},
        ...view.content !== undefined && view.content.length > 0 ? { content: toolResultContent(view.content) } : {},
      }
    case 'diff': {
      const rawPath = view.locations?.[0]?.path ?? view.diffs[0]?.path
      const content: AcpToolCallContent[] = view.diffs.map(d => ({ type: 'diff', path: d.path, oldText: d.oldText, newText: d.newText }))
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: displayTitle(view.title, rawPath, terminal.cwd),
        kind: 'edit',
        status: 'in_progress',
        ...view.locations !== undefined ? { locations: view.locations } : {},
        ...content.length > 0 ? { content } : {},
      }
    }
    case 'terminal': {
      // A terminal-rendered call gets a terminal CARD when the client supports it:
      // the description renders ABOVE the card, then the terminal block, plus
      // `_meta.terminal_info` (the cwd header). Without the capability it is an
      // ordinary execute card whose body is the description and whose rawInput is
      // the command; the output arrives as text on the result.
      const asTerminal = terminal.enabled
      const description: AcpToolCallContent[] = view.description !== undefined
        ? [{ type: 'content', content: { type: 'text', text: view.description } }]
        : []
      const content: AcpToolCallContent[] = [
        ...description,
        ...asTerminal ? [{ type: 'terminal' as const, terminalId: callId }] : [],
      ]
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: view.title,
        kind: 'execute',
        status: 'in_progress',
        rawInput: view.title,
        ...content.length > 0 ? { content } : {},
        ...asTerminal
          ? { _meta: { terminal_info: { terminal_id: callId, cwd: terminalCwd(view.cwd, terminal.cwd) } } }
          : {},
      }
    }
    default:
      return assertNever(view, 'ToolCallView.card')
  }
}

/** The `terminal_exit` `_meta` entry for a completed terminal call. */
interface TerminalExitMeta {
  terminal_exit?: { terminal_id: string; exit_code?: number; signal?: string }
}

/**
 * Build the optional `terminal_exit` portion of a `tool_call_update`'s `_meta`
 * from a terminal result: a `signal` death yields `{signal}`, an `exitCode`
 * yields `{exit_code}`, and neither yields nothing (the card simply shows no exit
 * pill). Spread into the `_meta` object alongside `terminal_output`.
 */
function terminalExitMeta(callId: string, view: TerminalResultView): TerminalExitMeta {
  if (view.signal !== undefined) return { terminal_exit: { terminal_id: callId, signal: view.signal } }
  if (view.exitCode !== undefined) return { terminal_exit: { terminal_id: callId, exit_code: view.exitCode } }
  return {}
}

/**
 * Build the `tool_call_update` (completed) `session/update` from a result render
 * intent. A `generic` result sends its reformatted content (or the raw result);
 * a `terminal` result rides its output/exit on `_meta` when the client is capable
 * (the terminal card consumes them and `content` is OMITTED — a
 * `tool_call_update.content` REPLACES the call's content collection in Zed, so
 * re-sending would clobber the terminal block the call installed) and otherwise
 * derives the fenced ```console fallback from `output`. A `diff` result emits its
 * `{ type: 'diff' }` content blocks (an applied hunk, or a whole-file diff for a
 * create), which replace the diff the call installed — so the model-facing result
 * text can never clobber it.
 */
function toolResultUpdate(callId: CallId, view: ToolResultView, isError: boolean, terminal: TerminalRendering): ToolCallSessionUpdate {
  const status = isError ? 'failed' as const : 'completed' as const
  switch (view.card) {
    case 'terminal': {
      const output = view.output ?? ''
      if (terminal.enabled) {
        return {
          sessionUpdate: 'tool_call_update',
          toolCallId: callId,
          status,
          ...view.title !== undefined ? { title: view.title } : {},
          _meta: {
            terminal_output: { terminal_id: callId, data: output },
            ...terminalExitMeta(callId, view),
          },
        }
      }
      // No terminal capability: the bridge derives the fenced ```console fallback.
      const fenced = `\`\`\`console\n${output.replace(/\n+$/, '')}\n\`\`\``
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        content: [{ type: 'content', content: { type: 'text', text: fenced } }],
        ...view.title !== undefined ? { title: view.title } : {},
      }
    }
    case 'generic':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        // The presenter fills a generic result's content from the raw result, so
        // `content` is always defined here; the guard keeps this total for a
        // directly-constructed view.
        /* v8 ignore next -- content always defined via the presenter (see above) */
        ...view.content !== undefined ? { content: toolResultContent(view.content) } : {},
        ...view.title !== undefined ? { title: view.title } : {},
      }
    case 'diff': {
      // A result-time diff: emit one `{ type: 'diff' }` content block per entry
      // (an applied hunk for an edit/overwrite, or a whole-file diff for a
      // create), mirroring the call-side diff arm. `tool_call_update.content`
      // REPLACES the call's content in an editor, so this result diff supersedes
      // the diff the pending card installed (and keeps the model-facing result
      // text from clobbering it).
      const content: AcpToolCallContent[] = view.diffs.map(d => ({ type: 'diff', path: d.path, oldText: d.oldText, newText: d.newText }))
      // Relativize the replacement title against the session cwd from the diff
      // path, exactly as the call-side card does — `tool_call_update.title`
      // replaces the card header, so a raw absolute path here would undo the
      // pending card's relativized title.
      const title = view.title !== undefined ? displayTitle(view.title, view.diffs[0]?.path, terminal.cwd) : undefined
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        ...content.length > 0 ? { content } : {},
        ...title !== undefined ? { title } : {},
      }
    }
    default:
      return assertNever(view, 'ToolResultView.card')
  }
}
