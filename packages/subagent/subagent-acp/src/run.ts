/**
 * Fresh-process ACP subagent client. Drives one child session and owns cancellation and
 * quiescent disposal.
 *
 * TODO(acp-subagent-replay): add snapshot-tier coverage with a separate replay fixture and
 * sessions root inside each child process. Current keyless coverage uses a scripted ACP child;
 * with-key coverage drives the real ACP example.
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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { buildChildEnv, disposeChildProcess, spawnFailure } from '@deepseek-ai/dsh-subagent-subprocess'

/** Fixed response to child permission requests: reject by default, or select the first allow option. */
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

/** EOF grace for child flush and nested-process teardown; wider than the signal grace below. */
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
 * Start and publish one ACP child after initialization and session creation.
 * Child failures resolve through the run result; startup failures reject after
 * process reap. Disposal cancels, kills, and reaps the child.
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved spawn spec: command/args/cwd, env, permission
 * policy, dispose graces, and the optional error sink.
 * @returns the ready run handle for the child subprocess.
 */
export async function startAcpRun(request: SubagentStartRequest, spec: AcpRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) throw new Error('subagent request was aborted before the ACP child started')
  // ACP session ids are unique only within the child server. The lifecycle id
  // is minted in the parent namespace so fresh processes cannot collide with
  // each other or with a local agent that happens to use the same session id.
  const id = SessionId(randomUUID())

  // Keep diagnostics on parent stderr; only ACP output contributes to the result.
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: buildChildEnv(spec.env),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  // Capture the child-process error event immediately.
  const spawnFailed = spawnFailure(child)

  // Startup rollback and the published handle share one process teardown.
  let processDisposal: Promise<void> | undefined
  const disposeProcess = (): Promise<void> => (processDisposal ??= disposeChildProcess(child, {
    disposeEofGraceMs: spec.disposeEofGraceMs,
    disposeGraceMs: spec.disposeGraceMs,
  }))

  // Accumulate the child's streamed assistant text — the SubagentResult output.
  const output: string[] = []
  // Shared mutable state keeps cancellation visible across async closures.
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
  // Cancellation settles the result without waiting for a cooperative child.
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
    // Best-effort ACP cancel; process teardown remains authoritative.
    /* v8 ignore next */
    if (sessionId !== undefined) void conn.cancel({ sessionId }).catch(() => { /* child gone / no session */ })
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  // The accumulated child text as harness ContentBlocks (empty array when the
  // child streamed nothing). Read at every return so a partial answer survives
  // a later cancel/error.
  const collectOutput = (): ContentBlock[] => {
    const text = output.join('')
    return text.length > 0 ? [{ type: 'text', text }] : []
  }

  // Establish the remote session before publishing a handle. Any failure owns
  // the still-private process and therefore reaps it before rejecting.
  try {
    await Promise.race([
      (async (): Promise<void> => {
        await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          // Advertise NO optional client capabilities (no fs, no terminal): the
          // child self-serves in its own process.
          clientCapabilities: {},
        })
        const session = await conn.newSession({ cwd: spec.cwd, mcpServers: [] })
        const returnedSessionId: unknown = Reflect.get(session, 'sessionId')
        if (typeof returnedSessionId !== 'string') throw new Error('ACP child published without a session id')
        sessionId = returnedSessionId
        if (flags.cancelled) throw new Error('subagent cancelled before the ACP session started')
      })(),
      spawnFailed.then((err): never => { throw err }),
      cancelSettled.then((): never => { throw new Error('subagent cancelled before the ACP session started') }),
    ])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    await disposeProcess()
    if (flags.cancelled) throw new Error('subagent request was aborted before the ACP child started')
    throw toError(error)
  }
  // The startup transaction validates the returned id before it can fulfill.
  // This assertion carries that cross-closure invariant into TypeScript.
  /* v8 ignore next */
  if (sessionId === undefined) throw new Error('unreachable: ACP startup fulfilled without a session id')
  const remoteSessionId = sessionId

  const result: Promise<SubagentResult> = (async (): Promise<SubagentResult> => {
    try {
      // Race the remote turn against local cancellation.
      const prompt = async (): Promise<SubagentResult> => {
        // The startup phase cannot fulfill without assigning the session id.
        const promptResult = await conn.prompt({ sessionId: remoteSessionId, prompt: toAcpPrompt(request.prompt) })
        return { output: collectOutput(), stopReason: acpStopReason(promptResult.stopReason) }
      }
      return await Promise.race([
        prompt(),
        cancelSettled.then((): SubagentResult => ({ output: collectOutput(), stopReason: 'aborted' })),
      ])
    } catch (error: unknown) {
      // Cover a process rejection already queued when cancellation arrives.
      /* v8 ignore next */
      if (flags.cancelled) return { output: collectOutput(), stopReason: 'aborted' }
      // Flatten post-publication transport failures while preserving diagnostics.
      try {
        spec.onError?.(toError(error), 'error')
      } catch {
        // The diagnostic sink cannot reject the run result.
      }
      return { output: collectOutput(), stopReason: 'error' }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  })()

  let disposal: Promise<void> | undefined
  return {
    id,
    result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      request.signal.removeEventListener('abort', onAbort)
      requestCancel()
      // The shared EOF → TERM → KILL ladder awaits exit. ACP normally quiesces
      // from stdin EOF, including the final flush, so this backend uses a wider
      // EOF grace before signals escalate.
      disposal = disposeProcess()
      return disposal
    },
  }
}
