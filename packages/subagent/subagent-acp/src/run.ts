/**
 * The out-of-process ACP subagent run driver. Spawns a child agent as a
 * subprocess, speaks the Agent Client Protocol (ACP) to it over stdio as the
 * CLIENT, drives one session to completion, and shapes the result into a
 * {@link SubagentResult}. The mirror image of the server-side bridge in
 * `@deepseek-ai/dsh-acp` (which is the ACP *agent* side): here we are the ACP
 * *client*, so we CALL `initialize`/`newSession`/`prompt`/`cancel` and we
 * IMPLEMENT the `Client` callbacks (`sessionUpdate`, `requestPermission`).
 *
 * One subprocess per run (fresh-process-per-run): `start` spawns, runs exactly
 * one ACP session, and `dispose` kills the subprocess and awaits its exit.
 * Persistent-process pooling is a future optimization (see the RFC).
 *
 * TODO(acp-subagent-replay): snapshot-tier coverage of an ACP child is a
 * distinct replay shape — each child is its own PROCESS with its own
 * single-agent replay (the child boots under `DSH_SNAPSHOT=replay` with its own
 * sessions-root + fixture), unlike the in-process per-session keying in
 * `dsh-llm-replay`. Deferred to a follow-up; keyless coverage here is via a
 * scripted mock ACP server subprocess, and the with-key e2e drives the real
 * `acp-agent` example. See the ACP-subagent-backend RFC.
 *
 * @module @deepseek-ai/dsh-subagent-acp/run
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type ContentBlock as AcpContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import { AgentId } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/**
 * How the client answers a child's `session/request_permission`. The first cut
 * does not surface permission prompts to a human, so every request is
 * auto-answered by this fixed policy:
 *
 * - `reject` — decline every prompt (answer `cancelled`). Safe default: a child
 *   that asks before a side effect does not get to take it.
 * - `allow` — approve every prompt by selecting its first `allow_*` option (or,
 *   if none is offered, `cancelled`). Use when the child is trusted to act.
 */
export type PermissionPolicy = 'allow' | 'reject'

/** Resolved spawn spec for an ACP child process (no defaults — see Config). */
export interface AcpRunSpec {
  /** The executable to spawn (the child ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /** Working directory for the child process AND its ACP session `cwd`. */
  cwd: string
  /** How to auto-answer the child's permission prompts. */
  permission: PermissionPolicy
  /**
   * Extra environment variables to ADD for the child (e.g. the child harness's
   * `DEEPSEEK_API_KEY`). Merged on top of the scrubbed ambient env — see
   * {@link buildChildEnv}. A value here is forwarded even if its name matches
   * the credential-scrub pattern (an explicit opt-in for the child's own creds).
   */
  env: Record<string, string>
  /**
   * Grace period (ms) for the child's EOF-driven quiesce in
   * {@link SubagentRun.dispose} — the window to flush persistence and tear down
   * its OWN nested subprocesses before the parent escalates to a signal. The
   * plugin fills this from its `disposeEofGraceMs` config.
   */
  disposeEofGraceMs: number
  /**
   * Grace period (ms) between `SIGTERM` and the `SIGKILL` escalation in
   * {@link SubagentRun.dispose}. The plugin fills this from its
   * `disposeGraceMs` config.
   */
  disposeGraceMs: number
  /**
   * Sink for a child-level failure that the run flattened into a stop reason
   * (the seam contract forbids `result` rejecting). The driver calls this with
   * the original error and the chosen stop reason so the fault is preserved
   * rather than silently lost; the provider wires it to `ctx.logger.warn`.
   * Optional — omitted in a unit test that asserts the stop reason directly.
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/**
 * Default grace for the child's EOF-driven quiesce on dispose (the
 * `disposeEofGraceMs` config) — the window for it to flush persistence and tear
 * down its OWN nested subprocesses (which may run their own `SIGTERM`→`SIGKILL`
 * escalation) before the parent escalates to a signal. Deliberately LARGER than
 * {@link DEFAULT_DISPOSE_GRACE_MS}: a cooperative child whose teardown is itself
 * waiting on a signal-trapping grandchild (e.g. a bash subprocess in its own ~3s
 * SIGTERM→SIGKILL grace) plus a final flush needs MORE than a single
 * signal-grace of headroom, or the parent's SIGTERM cuts it off exactly as it
 * reaches its own SIGKILL+flush. The child is an arbitrary ACP agent, so this is
 * a standalone generous default, NOT derived from any child's internals.
 */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** Default grace between SIGTERM and SIGKILL on dispose (the `disposeGraceMs` config; mirrors the bash executor). */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/**
 * Credential-shaped ambient env vars are NOT forwarded to the child by default
 * (the parent harness's own `DEEPSEEK_API_KEY`/secrets must not leak into a
 * spawned process implicitly). Same pattern as the bash executor. The child
 * agent needs its OWN credentials to reach a model — those are supplied
 * explicitly via {@link AcpRunSpec.env}, which is layered on top AFTER the
 * scrub, so an intended `DEEPSEEK_API_KEY` survives while an incidental
 * `AWS_SECRET_ACCESS_KEY` does not.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN/i

/**
 * The ambient env minus credential-shaped vars, plus the spec's explicit env.
 * @param extra - explicit vars layered on top AFTER the scrub, so a
 * credential-shaped name supplied deliberately still reaches the child.
 * @returns the environment to spawn the child with.
 */
export function buildChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_PATTERN.test(key)) env[key] = value
  }
  return { ...env, ...extra }
}

/**
 * Map an ACP {@link StopReason} to a harness {@link SubagentStopReason}.
 * @param reason - the terminal reason from the child's `session/prompt` response.
 * @returns the harness equivalent; `max_turn_requests` and any unknown future
 * variant map to `error`, so an unclean stop is never reported as `completed`.
 */
export function acpStopReason(reason: StopReason): SubagentStopReason {
  switch (reason) {
    case 'end_turn':
      return 'completed'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    case 'cancelled':
      return 'aborted'
    // `max_turn_requests` (the child hit its turn-request budget) has no direct
    // harness equivalent and means the task did NOT finish cleanly — surface it
    // as a generic failure so the consumer maps it to an isError result rather
    // than reporting a partial answer as success.
    case 'max_turn_requests':
      return 'error'
    // ACP StopReason is a closed wire union, but a future SDK could add a
    // variant; treat an unknown terminal reason as a failure (never silently
    // 'completed').
    default:
      return 'error'
  }
}

/**
 * Collect the text of an ACP content block (non-text blocks contribute nothing).
 * @param content - the content block off a streamed `agent_message_chunk`.
 * @returns the block's text, or `''` for a non-text block.
 */
export function acpContentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/**
 * Translate the harness prompt blocks into ACP prompt blocks (text only).
 * @param prompt - the harness prompt; non-text blocks are dropped.
 * @returns the ACP text blocks, in order.
 */
export function toAcpPrompt(prompt: ContentBlock[]): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  for (const block of prompt) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
  }
  return blocks
}

/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value: unknown): Error {
  // The catch only sees rejections from the ACP SDK RPCs and the spawn `error`
  // event, which are always `Error`s; the `String(value)` arm is a defensive
  // fallback for a non-Error throw that the typed surfaces cannot produce.
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** Resolve once the child process exits (any code/signal); immediate if gone. */
function waitForExit(child: ChildProcess): Promise<void> {
  // Already-exited fast path: dispose guards on exitCode before calling, so in
  // tests the child is always still alive here.
  /* v8 ignore next */
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>(resolve => child.once('exit', () => { resolve() }))
}

/** Resolve `true` if the child exits within `ms`, `false` on timeout. */
function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  return Promise.race([
    waitForExit(child).then(() => true),
    // `.unref()` so a pending grace timer never keeps the parent's loop alive.
    new Promise<boolean>(resolve => setTimeout(() => { resolve(false) }, ms).unref()),
  ])
}

/**
 * Start an out-of-process ACP child for `request` and return a {@link SubagentRun}.
 *
 * Spawns the configured command, wraps its stdio in an ACP `ClientSideConnection`,
 * and drives one session: `initialize` → `newSession` → `prompt`. The accumulated
 * `agent_message_chunk` text is the result output; the prompt's terminal
 * `StopReason` maps to the stop reason. `result` never REJECTS on a child-level
 * failure (a spawn/transport/RPC error resolves with `stopReason: 'error'`), per
 * the seam contract. `cancel()` sends `session/cancel`; `dispose()` kills the
 * subprocess and awaits its exit (quiescent teardown).
 * @param request - the start request; the driver consumes `prompt` and `signal`
 * (an already-aborted signal yields an inert `aborted` run with no spawn).
 * @param spec - the resolved spawn spec: command/args/cwd, env, permission
 * policy, dispose graces, and the optional error sink.
 * @returns the live run handle for the child subprocess.
 */
export function startAcpRun(request: SubagentStartRequest, spec: AcpRunSpec): SubagentRun {
  const id = AgentId(randomUUID())

  // A request already aborted before it starts never spawns the child at all —
  // return an inert run that settled `aborted`, rather than launching the
  // configured binary just to tear it down. `dispose`/`cancel` are no-ops.
  if (request.signal?.aborted) {
    return {
      id,
      result: Promise.resolve({ output: [], stopReason: 'aborted' }),
      cancel(_reason?: string): void { /* nothing was started */ },
      dispose(): Promise<void> { return Promise.resolve() },
    }
  }

  // Spawn the child ACP agent. stdin = ACP request channel, stdout = ACP
  // response channel, stderr = INHERIT so the child's diagnostics surface on the
  // parent's stderr (no separate capture to drain — we don't fold child stderr
  // into the result; the seam reports only output + stop reason).
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: buildChildEnv(spec.env),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  // A spawn-level failure (e.g. ENOENT for a bad command) is emitted as an
  // `error` event, NOT a thrown exception — without a listener Node treats it as
  // an unhandled error and crashes the parent. Capture it into a promise the
  // result path races, so a bad command settles `error` like any child failure.
  const spawnFailed = new Promise<Error>((resolve) => {
    child.once('error', (err) => { resolve(err) })
  })

  // Accumulate the child's streamed assistant text — the SubagentResult output.
  const output: string[] = []
  // `cancelled` records that a cancel was requested (signal or cancel()), so a
  // run torn down before the prompt resolves settles `aborted` rather than the
  // generic error mapping. Held on a mutable object so the async closures that
  // set it (the abort listener) and the IIFE that reads it don't fight TS's
  // control-flow narrowing of a bare `let` (which would type the catch-time read
  // as always-`false`).
  const flags = { cancelled: false }

  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk') {
        output.push(acpContentText(update.content))
      }
      // Other updates (thoughts, tool calls, plans) are consumed but not
      // surfaced in this cut — the subagent returns only its final answer.
      return Promise.resolve()
    },
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      // Auto-answer by the configured policy. `allow` selects the first
      // allow-shaped option the child offered; if it offered none (or we
      // reject), answer `cancelled` so the child does not proceed.
      if (spec.permission === 'allow') {
        const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
        if (allow !== undefined) {
          return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
        }
      }
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    },
  })

  const conn = new ClientSideConnection(
    makeClient,
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  )

  let sessionId: string | undefined
  // Resolves when a cancel is requested, so `result` can settle `aborted` even
  // if the child never cooperates with `session/cancel` (it ignores the notify,
  // or the prompt wedges). The result path races this against the ACP drive: the
  // FIRST to settle wins, so `cancel()` always honors the contract (`result`
  // settles `aborted`) without waiting on a non-cooperative child. `dispose`
  // still kills the process and reaps it; this only unblocks `result`. The
  // executor runs synchronously, so `signalCancelSettled` is assigned before the
  // Promise constructor returns (the `!` asserts the definite assignment).
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    flags.cancelled = true
    signalCancelSettled()
    // Best-effort: tell the child to cancel the in-flight turn. Swallows a
    // rejection — the session may not exist yet, or the pipe may be gone; the
    // dispose path kills the process regardless. If the session has NOT been
    // created yet (cancel raced ahead of `newSession`), the `cancelled` flag
    // alone carries it: the result path re-checks the flag after each await and
    // settles `aborted` without running the prompt. The `.catch` swallow is
    // defensive for a narrow transport race (child gone mid-send) — v8-ignored
    // because dispose kills the process regardless, so it can't be hit in tests.
    /* v8 ignore next */
    if (sessionId !== undefined) void conn.cancel({ sessionId }).catch(() => { /* child gone / no session */ })
  }
  const onAbort = (): void => { requestCancel() }
  request.signal?.addEventListener('abort', onAbort, { once: true })

  const result: Promise<SubagentResult> = (async (): Promise<SubagentResult> => {
    // The accumulated child text as harness ContentBlocks (empty array when the
    // child streamed nothing). Read at every return so a partial answer survives
    // a later cancel/error.
    const collectOutput = (): ContentBlock[] => {
      const text = output.join('')
      return text.length > 0 ? [{ type: 'text', text }] : []
    }
    try {
      // Race three outcomes, first to settle wins:
      //  - driveAcp: the normal initialize → newSession → prompt path;
      //  - spawnFailed: a bad command never speaks ACP, so `initialize` would
      //    hang forever — the spawn `error` event is the only signal, and a
      //    rejected race settles the run `error` via the catch;
      //  - cancelSettled: a cancel was requested — settle `aborted` immediately
      //    rather than waiting on a child that may ignore `session/cancel` or
      //    wedge the prompt (the `cancel()` contract: `result` settles `aborted`).
      const driveAcp = async (): Promise<SubagentResult> => {
        await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          // Advertise NO optional client capabilities (no fs, no terminal): the
          // child self-serves in its own process.
          clientCapabilities: {},
        })
        const session = await conn.newSession({ cwd: spec.cwd, mcpServers: [] })
        sessionId = session.sessionId
        // A cancel that raced ahead of `newSession` set `cancelled` but could not
        // send `session/cancel` (no session id yet). Honor it here: settle
        // `aborted` without ever issuing the prompt, rather than running the child
        // to completion and ignoring the cancel.
        if (flags.cancelled) return { output: collectOutput(), stopReason: 'aborted' }
        const promptResult = await conn.prompt({ sessionId, prompt: toAcpPrompt(request.prompt) })
        return { output: collectOutput(), stopReason: acpStopReason(promptResult.stopReason) }
      }
      return await Promise.race([
        driveAcp(),
        spawnFailed.then((err): SubagentResult => { throw err }),
        cancelSettled.then((): SubagentResult => ({ output: collectOutput(), stopReason: 'aborted' })),
      ])
    } catch (error: unknown) {
      // The seam contract: result resolves (never rejects) on a child-level
      // failure. Cancellation is handled by the `cancelSettled` race arm above
      // (it settles `aborted` the instant cancel is requested, beating any
      // rejection), so a rejection that reaches HERE is always a genuine
      // child-level error — the awaited ACP RPCs or the spawn-failure race
      // (initialize/newSession/prompt transport/RPC errors, or ENOENT), not a
      // local bug. Flatten to `error` and surface the original via onError so a
      // real fault is preserved rather than silently lost.
      spec.onError?.(toError(error), 'error')
      return { output: collectOutput(), stopReason: 'error' }
    }
  })()

  return {
    id,
    result,
    cancel(_reason?: string): void {
      requestCancel()
    },
    async dispose(): Promise<void> {
      request.signal?.removeEventListener('abort', onAbort)
      // Reach quiescence, not merely request it (dispose must AWAIT the child
      // actually stopping). If the child is already gone, nothing to do.
      if (child.exitCode !== null || child.signalCode !== null) return
      const eofGraceMs = spec.disposeEofGraceMs
      const graceMs = spec.disposeGraceMs
      // 1. Graceful: end the ACP request stream (stdin EOF) and let the child
      //    quiesce ON ITS OWN. Our acp-agent has NO SIGTERM handler in a normal
      //    session — it tears down via the server bridge's connection-close path
      //    (conn.closed → per-agent dispose → final session/flush), driven by the
      //    stdin EOF, NOT by a signal. A prompt response can resolve from a
      //    turn/end BEFORE that post-turn flush lands, so the child still has
      //    durable work owed when dispose runs. Give the EOF-driven quiesce a real
      //    window — wider than a single signal-grace, since the child's own
      //    teardown may itself be awaiting a signal-trapping grandchild (a bash
      //    subprocess in its own SIGTERM→SIGKILL grace) plus a flush — and only
      //    escalate if it overruns. Sending SIGTERM in the same tick (or too soon)
      //    would default-terminate the child mid-flush, orphaning its nested work.
      child.stdin.end()
      if (await exitsWithin(child, eofGraceMs)) return
      // 2. SIGTERM, then escalate to SIGKILL if it still does not exit within the
      //    grace period — a child that ignores EOF and traps SIGTERM must not
      //    wedge dispose forever (the seam requires bounded quiescence).
      child.kill('SIGTERM')
      if (await exitsWithin(child, graceMs)) return
      // 3. Force-kill and await the (now-certain) exit.
      child.kill('SIGKILL')
      await waitForExit(child)
    },
  }
}
