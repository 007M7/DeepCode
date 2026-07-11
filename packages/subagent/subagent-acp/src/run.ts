/**
 * The out-of-process ACP subagent run driver.
 * @module @deepseek-ai/dsh-subagent-acp/run
 */

import { spawn } from 'node:child_process'
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
import { buildChildEnv, disposeChildProcess, spawnFailure } from '@deepseek-ai/dsh-subagent-subprocess'

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
   * A throw from the sink itself is contained — it cannot reject `result`.
   * Optional — omitted in a unit test that asserts the stop reason directly.
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/**
 * Default grace for the child's EOF-driven quiesce on dispose (the `disposeEofGraceMs` config)
 * — the window for it to flush persistence and tear down its own nested subprocesses (which
 * may run their own `SIGTERM`→`SIGKILL` escalation) before the parent escalates to a signal.
 */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** Default grace between SIGTERM and SIGKILL on dispose (the `disposeGraceMs` config; mirrors the bash executor). */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

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

/**
 * Start an out-of-process ACP child for `request` and return a {@link SubagentRun}.
 *
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
    const started = Promise.reject(new Error('subagent request was aborted before the ACP child started'))
    // The result is derived from the same boundary so the readiness rejection
    // is observed even when this provider is driven directly rather than
    // through SubagentService.
    const result: Promise<SubagentResult> = started.catch(() => ({ output: [], stopReason: 'aborted' }))
    return {
      id,
      started,
      result,
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
  // Same-tick capture (the library's contract): a spawn-level failure (e.g.
  // ENOENT for a bad command) is an `error` EVENT that would crash the parent
  // unheard; the result path races this promise, so a bad command settles
  // `error` like any child failure.
  const spawnFailed = spawnFailure(child)

  // Accumulate the child's streamed assistant text — the SubagentResult output.
  const output: string[] = []
  // `cancelled` records that a cancel was requested (signal or cancel()), so a run torn down
  // before the prompt resolves settles `aborted` rather than the generic error mapping.
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
  // Resolves when a cancel is requested, so `result` can settle `aborted` even if the child
  // never cooperates with `session/cancel` (it ignores the notify, or the prompt wedges).
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    flags.cancelled = true
    signalCancelSettled()
    // Best-effort: tell the child to cancel the in-flight turn.
    /* v8 ignore next */
    if (sessionId !== undefined) void conn.cancel({ sessionId }).catch(() => { /* child gone / no session */ })
  }
  const onAbort = (): void => { requestCancel() }
  request.signal?.addEventListener('abort', onAbort, { once: true })

  // The accumulated child text as harness ContentBlocks (empty array when the
  // child streamed nothing). Read at every return so a partial answer survives
  // a later cancel/error.
  const collectOutput = (): ContentBlock[] => {
    const text = output.join('')
    return text.length > 0 ? [{ type: 'text', text }] : []
  }

  // A provider is "started" only once the remote child has completed ACP initialization and
  // published a session.
  const started: Promise<void> = Promise.race([
    (async (): Promise<void> => {
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        // Advertise NO optional client capabilities (no fs, no terminal): the
        // child self-serves in its own process.
        clientCapabilities: {},
      })
      const session = await conn.newSession({ cwd: spec.cwd, mcpServers: [] })
      sessionId = session.sessionId
      if (flags.cancelled) throw new Error('subagent cancelled before the ACP session started')
    })(),
    spawnFailed.then((err): never => { throw err }),
    cancelSettled.then((): never => { throw new Error('subagent cancelled before the ACP session started') }),
  ])

  const result: Promise<SubagentResult> = (async (): Promise<SubagentResult> => {
    try {
      // Readiness is the initialize → newSession phase above.
      await started

      // Race two post-start outcomes, first to settle wins: - prompt: the normal remote turn; -
      // cancelSettled: a cancel was requested — settle `aborted` immediately rather than
      // waiting on a child that may ignore `session/cancel` or wedge the prompt (the `cancel()`
      // contract: `result` settles `aborted`).
      const prompt = async (): Promise<SubagentResult> => {
        // `started` cannot fulfill without assigning the session id; the cast
        // records that local invariant without an unreachable defensive arm.
        const promptResult = await conn.prompt({ sessionId: sessionId as string, prompt: toAcpPrompt(request.prompt) })
        return { output: collectOutput(), stopReason: acpStopReason(promptResult.stopReason) }
      }
      return await Promise.race([
        prompt(),
        cancelSettled.then((): SubagentResult => ({ output: collectOutput(), stopReason: 'aborted' })),
      ])
    } catch (error: unknown) {
      if (flags.cancelled) return { output: collectOutput(), stopReason: 'aborted' }
      // The seam contract: result resolves (never rejects) on a child-level failure.
      try {
        spec.onError?.(toError(error), 'error')
      } catch {
        // Swallows only the caller-supplied sink's OWN throw: an unguarded
        // sink exception would reject `result` and break the contract above.
        // The child-level failure being reported still settles as `error`.
      }
      return { output: collectOutput(), stopReason: 'error' }
    }
  })()

  return {
    id,
    started,
    result,
    cancel(_reason?: string): void {
      requestCancel()
    },
    async dispose(): Promise<void> {
      request.signal?.removeEventListener('abort', onAbort)
      // Quiescent teardown via the shared ladder (stdin EOF → SIGTERM → SIGKILL, awaiting the
      // actual exit).
      await disposeChildProcess(child, {
        disposeEofGraceMs: spec.disposeEofGraceMs,
        disposeGraceMs: spec.disposeGraceMs,
      })
    },
  }
}
