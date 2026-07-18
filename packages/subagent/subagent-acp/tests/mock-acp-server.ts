/**
 * Minimal no-network ACP child process for keyless backend tests. Environment variables script its
 * text and stop reason, a cancel-cooperative or cancel-ignoring hang, permission requests, and a
 * readiness marker. Disposal fixtures can delay an EOF flush, ignore EOF but exit and mark
 * SIGTERM, or trap SIGTERM to require SIGKILL. The specs run this protocol-only fixture directly
 * with Node's type stripping; it imports no harness code or workspace paths.
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
const CRASH_ON_PROMPT = process.env.MOCK_CRASH_ON_PROMPT === '1'
const IGNORE_CANCEL = process.env.MOCK_IGNORE_CANCEL === '1'
const READY_FILE = process.env.MOCK_READY_FILE
const FLUSH_ON_EOF = process.env.MOCK_FLUSH_ON_EOF
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
      if (CRASH_ON_PROMPT) process.exit(1)
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
      if (IGNORE_CANCEL) {
        // A non-cooperative child receives cancellation but neither resolves nor exits. The
        // backend must still settle `aborted`, and disposal must kill the process.
        return Promise.resolve()
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

// Under MOCK_TRAP_SIGTERM, ignore SIGTERM and keep stdin open so the process neither quiesces
// on EOF nor dies on the graceful signal — exercising the backend dispose path's SIGKILL
// escalation. READY_FILE proves the trap was armed before the test disposes the run.
if (process.env.MOCK_TRAP_SIGTERM === '1') {
  process.on('SIGTERM', () => { /* trapped: refuse to exit on the graceful signal */ })
  // Keep the event loop alive (a bare timer) so nothing else lets it exit.
  setInterval(() => { /* stay alive until SIGKILL */ }, 1000)
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'trap-armed')
}

// Under MOCK_FLUSH_ON_EOF, model the real acp-agent's EOF-driven quiesce: on stdin 'end' (the
// dispose path's `child.stdin.end()`), take an ASYNC beat to "flush", then touch the marker and
// exit on its own. A signal sent before MOCK_FLUSH_DELAY_MS would suppress the marker, so it proves
// the EOF grace window was long enough for durable flush.
if (FLUSH_ON_EOF !== undefined) {
  const flushDelayMs = Number(process.env.MOCK_FLUSH_DELAY_MS ?? '150')
  process.stdin.on('end', () => {
    setTimeout(() => {
      writeFileSync(FLUSH_ON_EOF, 'flushed')
      process.exit(0)
    }, flushDelayMs)
  })
}

// Ignore EOF but exit on SIGTERM to exercise the middle disposal tier before SIGKILL. The signal
// marker distinguishes that catchable rung from an immediate, uncatchable SIGKILL; READY_FILE
// proves the handler was armed before disposal.
if (process.env.MOCK_IGNORE_EOF === '1') {
  const sigtermFile = process.env.MOCK_SIGTERM_FILE
  process.on('SIGTERM', () => {
    if (sigtermFile !== undefined) writeFileSync(sigtermFile, 'sigterm')
    process.exit(0)
  })
  setInterval(() => { /* stay alive past EOF until SIGTERM */ }, 1000)
  if (READY_FILE !== undefined) writeFileSync(READY_FILE, 'ignore-eof-armed')
}
