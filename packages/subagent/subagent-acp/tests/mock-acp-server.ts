/**
 * A minimal mock ACP AGENT, run as a subprocess, for the keyless
 * `dsh-subagent-acp` tests. It speaks the agent side of ACP over stdio and is
 * fully scripted by environment variables — no model, no network:
 *
 * - `MOCK_TEXT`        — the assistant text it streams as one `agent_message_chunk`.
 * - `MOCK_STOP`        — the ACP `StopReason` it returns from `prompt`
 *                        (`end_turn` default, or `max_tokens`/`refusal`/…).
 * - `MOCK_HANG`        — if `1`, `prompt` never resolves on its own (it waits for
 *                        a `session/cancel`), to exercise the client's cancel path.
 * - `MOCK_PERMISSION`  — if `1`, the agent calls `session/request_permission`
 *                        before answering, to exercise the client's auto-answer.
 * - `MOCK_READY_FILE`  — if set, the path the agent touches once its `prompt`
 *                        handler is in flight (it has streamed its chunk). A test
 *                        polls for this file to cancel on a CONDITION rather than
 *                        an arbitrary timeout (subprocess cold-start is variable).
 *
 * It is NOT a test spec (no `describe`/`it`) — it is spawned BY the specs as the
 * child process the ACP backend drives. Kept as a `.ts` run under tsx by the
 * spec (which passes its own tsconfig), mirroring how the snapshot harness boots
 * the real example.
 *
 * @module @deepseek-ai/dsh-subagent-acp/tests/mock-acp-server
 */

import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type CancelNotification,
  type AuthenticateRequest,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type StopReason,
} from '@agentclientprotocol/sdk'

const TEXT = process.env.MOCK_TEXT ?? 'mock child answer'
const STOP = (process.env.MOCK_STOP ?? 'end_turn') as StopReason
const HANG = process.env.MOCK_HANG === '1'
const WANT_PERMISSION = process.env.MOCK_PERMISSION === '1'
const NO_ALLOW = process.env.MOCK_NO_ALLOW === '1'
const THOUGHT = process.env.MOCK_THOUGHT === '1'
const CRASH_ON_CANCEL = process.env.MOCK_CRASH_ON_CANCEL === '1'
const READY_FILE = process.env.MOCK_READY_FILE
// When MOCK_NEWSESSION_READY/GO are set, newSession touches READY then blocks
// until GO appears — letting a test cancel mid-newSession deterministically.
const NEWSESSION_GATE = process.env.MOCK_NEWSESSION_READY !== undefined && process.env.MOCK_NEWSESSION_GO !== undefined
  ? { ready: process.env.MOCK_NEWSESSION_READY, go: process.env.MOCK_NEWSESSION_GO }
  : undefined

function makeAgent(conn: AgentSideConnection): Agent {
  // Pending cancel resolver for the HANG path: a `session/cancel` resolves the
  // prompt with `cancelled`.
  let resolveCancel: ((reason: StopReason) => void) | undefined

  return {
    initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
      })
    },
    async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
      // Optionally signal "newSession reached" and block until released, so a
      // test can cancel DURING newSession (the early-cancel race window) on a
      // condition rather than a timeout.
      if (NEWSESSION_GATE !== undefined) {
        writeFileSync(NEWSESSION_GATE.ready, 'at-newSession')
        while (!existsSync(NEWSESSION_GATE.go)) await new Promise(r => setTimeout(r, 10))
      }
      return { sessionId: randomUUID() }
    },
    authenticate(_params: AuthenticateRequest): Promise<void> {
      // No auth methods advertised; nothing to do.
      return Promise.resolve()
    },
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      if (WANT_PERMISSION) {
        // Ask the client to approve before answering; honor its decision. Under
        // MOCK_NO_ALLOW the only options are reject-shaped, so an `allow`-policy
        // client finds no allow option and must fall back to cancelled.
        const options = NO_ALLOW
          ? [{ optionId: 'no', name: 'Reject', kind: 'reject_once' as const }]
          : [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
          ]
        const decision = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'mock-call', title: 'mock side effect' },
          options,
        })
        if (decision.outcome.outcome === 'cancelled') {
          return { stopReason: 'cancelled' }
        }
      }
      // Optionally emit a NON-message update first (a thought), so the client's
      // sessionUpdate sees an update it must consume-but-not-accumulate.
      if (THOUGHT) {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } },
        })
      }
      // Stream the canned assistant text as one chunk.
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: TEXT } },
      })
      // Signal "prompt is in flight" by touching the readiness file, so a test
      // can wait on a CONDITION (file exists) rather than an arbitrary timeout
      // before cancelling — deterministic regardless of subprocess cold-start.
      if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ready')
      if (HANG) {
        // Never resolve on our own: wait for session/cancel to settle us.
        return new Promise<PromptResponse>((resolve) => {
          resolveCancel = (reason) => { resolve({ stopReason: reason }) }
        })
      }
      return { stopReason: STOP }
    },
    cancel(_params: CancelNotification): Promise<void> {
      if (CRASH_ON_CANCEL) {
        // Exit hard instead of answering — tears the ACP pipe, so the client's
        // pending prompt REJECTS (exercises the backend's catch-while-cancelled
        // path: a transport failure after a cancel settles `aborted`).
        process.exit(1)
      }
      resolveCancel?.('cancelled')
      return Promise.resolve()
    },
  }
}

new AgentSideConnection(
  makeAgent,
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
)
