/**
 * Shared test fixtures for the ACP bridge specs. A plain module (NOT a
 * *.spec.ts) so importing it does not re-register a describe block.
 *
 * `makeBridgeHarness` builds a full in-memory cordis context (llm + session +
 * system-prompt + tools + agents + agent-loop + persistence) with the ACP
 * bridge wired to an in-memory transport, plus a `ClientSideConnection` on the
 * other end — so a test drives the bridge exactly as an editor would, with no
 * subprocess and no real stdio.
 */

import { Context } from 'cordis'
import LlmService, { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-policy'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import * as AcpPlugin from '../src/index.ts'
import { type AcpConfig } from '../src/index.ts'

/** A scripted mock adapter (mirrors the agent-loop test adapter). */
class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private script: (StreamChunk[] | 'hang')[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Scripted text response ending in a clean `stop` finish. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted response ending at the output-token ceiling (max-tokens finish). */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Scripted response that fails mid-turn with a finish-error chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', message, code: 'PROVIDER_ERROR' } },
  ]
}

/** Scripted single tool call (no follow-up step scripted by default). */
export function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const argumentsJson = JSON.stringify(args)
  const id = CallId(rawCallId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A captured `session/update` notification (the update payload only). */
export type CapturedUpdate = SessionNotification['update']

export interface BridgeHarness {
  ctx: Context
  client: ClientSideConnection
  adapter: MockAdapter
  /** Every `session/update` the bridge pushed, in order (payload only). */
  updates: CapturedUpdate[]
  /** Same, but tagged with each update's `sessionId` (for multi-session demux assertions). */
  sessionUpdates: { sessionId: string; update: CapturedUpdate }[]
  /** Permission requests the bridge issued (none until the gate lands). */
  permissionRequests: RequestPermissionRequest[]
  /** Decide each permission request's outcome (default: cancelled). */
  onPermission: (req: RequestPermissionRequest) => RequestPermissionResponse
  /** If set, the client's sessionUpdate throws this (tests notify error path). */
  onSessionUpdateError: (() => void) | undefined
  /**
   * Sever the client→agent transport (close the writable the agent reads),
   * which ends the agent-side stream and resolves the bridge's `conn.closed` —
   * simulating an editor disconnecting. Returns once the close is requested.
   */
  closeClientTransport: () => Promise<void>
  /**
   * The child fiber the ACP bridge is mounted in. Disposing it tears down JUST
   * the bridge (its `ctx.on` listeners + effect) while the rest of the harness
   * stays up — an ACP-only HMR reload.
   */
  acpFiber: Awaited<ReturnType<Context['plugin']>>
  dispose: () => Promise<void>
  storageDir: string
}

/**
 * Build the bridge + a connected client over an in-memory transport pair.
 *
 * Two identity `TransformStream`s cross-wired (agent writes → client reads,
 * client writes → agent reads) give a faithful bidirectional JSON-RPC channel.
 * The bridge's `apply` receives the agent-side `Stream` via `config.stream`;
 * the test holds the `ClientSideConnection`.
 *
 * Pass `config: { model: undefined }` to override the default `model: 'mock'`
 * (the model key is dropped entirely when explicitly undefined).
 */
export async function makeBridgeHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: Partial<AcpConfig>
  /** Deployment persona for the tree (the system-prompt plugin's config). */
  persona?: string
  storageDir: string
  /**
   * Plug the REAL `dsh-bash-local` executor + `dsh-tool-bash` tools (instead of
   * a test's own inline tool). Lets a test drive the actual `bash` tool — its
   * real `presentCall`/`presentResult` — through the bridge, so tool-call UI
   * tests verify the SHIPPING tool, not a stand-in (docs/testing.md "prefer the real
   * implementation over a mock in tests").
   */
  withBash?: boolean
  /**
   * Plug the REAL `dsh-tool-todo` tool so a test can drive `todo_write` through
   * the bridge and assert the resulting `plan` sessionUpdate — the shipping
   * tool + the bridge's own todo/write→plan mapping, not a stand-in.
   */
  withTodo?: boolean
  /**
   * Plug the REAL filesystem stack (`dsh-fs-local` + `dsh-fs-policy` +
   * `dsh-tool-fs`) so a test can drive `read`/`write`/`edit` through the bridge
   * and assert their tool-owned presentation (title/kind/`locations`) on the
   * wire — the shipping tools, not a stand-in. `fsCwd` sets the local backend's
   * base directory (default: `storageDir`).
   */
  withFs?: boolean
  fsCwd?: string
} = { storageDir: '' }): Promise<BridgeHarness> {
  const adapter = new MockAdapter(options.script ?? [])

  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: options.persona ?? '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionPersistenceJsonl, { root: options.storageDir })
  if (options.withBash) {
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    await ctx.plugin(ToolBash)
  }
  if (options.withTodo) {
    await ctx.plugin(ToolTodo)
  }
  if (options.withFs) {
    await ctx.plugin(LocalFileSystem, { cwd: options.fsCwd ?? options.storageDir })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(ToolFs)
  }
  ctx.llm.registerAdapter(['mock'], adapter)

  // Two identity byte pipes cross-wired into the two ndJsonStreams: bytes the
  // agent writes flow to the client's reader and vice versa. (ndJsonStream
  // takes (output, input): the agent writes to a2c and reads from c2a; the
  // client writes to c2a and reads from a2c.) The client→agent path (c2a) runs
  // through a hand-held writer so a test can close it (`closeClientTransport`)
  // to simulate the editor disconnecting — closing it EOFs the agent's reader
  // and resolves the bridge's `conn.closed`.
  const a2c = new TransformStream<Uint8Array, Uint8Array>()
  const c2a = new TransformStream<Uint8Array, Uint8Array>()
  const c2aWriter = c2a.writable.getWriter()
  // A WritableStream the client writes into; each chunk is forwarded to the
  // held c2a writer. `closeClientTransport` closes that writer directly.
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => c2aWriter.write(chunk),
  })

  const agentStream: Stream = ndJsonStream(a2c.writable, c2a.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, a2c.readable)

  const updates: CapturedUpdate[] = []
  const sessionUpdates: { sessionId: string; update: CapturedUpdate }[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    updates,
    sessionUpdates,
    permissionRequests,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    onSessionUpdateError: undefined,
    client: undefined as unknown as ClientSideConnection,
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    // Close the writable the CLIENT writes to (c2a) — its readable, which the
    // agent's ndJsonStream consumes, then EOFs cleanly, so the bridge's
    // `conn.closed` resolves and it sees the client disconnect. If the client
    // connection holds a writer lock on it, abort the connection's signal path
    // instead by closing through the underlying stream.
    closeClientTransport: async () => { await c2aWriter.close() },
    dispose: async () => { await ctx.fiber.dispose() },
    storageDir: options.storageDir,
  }

  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      updates.push(params.update)
      sessionUpdates.push({ sessionId: params.sessionId, update: params.update })
      // Let a test force the bridge's notify() error path.
      if (harness.onSessionUpdateError) return Promise.reject(new Error('client update rejected'))
      return Promise.resolve()
    },
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      permissionRequests.push(params)
      return Promise.resolve(harness.onPermission(params))
    },
  })

  // Wire the bridge (agent side) and the client (test side). The test config
  // can override `model` (including to undefined): default to 'mock' unless the
  // caller explicitly set the key (even to undefined), so a `{ model: undefined }`
  // override means "no model at all".
  const cfg: AcpConfig = { stream: agentStream, ...options.config }
  if (!(options.config && 'model' in options.config)) cfg.model = 'mock'
  // Mount the bridge the way production does: as a cordis PLUGIN (via
  // `ctx.plugin` with the real `inject`), NOT `AcpPlugin.apply(ctx, cfg)`
  // directly on the root ctx. The plugin fiber is the faithful reproduction —
  // the bridge's `apply` runs inside the fiber's injection scope, and its ACP
  // handlers later run from the JSON-RPC read loop OUTSIDE that scope, exactly
  // as under the example's cordis.yml. (Mounting directly on root made every
  // service an ungated property and hid the "cannot get property … without
  // inject" failure that bit a real Zed session.) `harness.acpFiber.dispose()`
  // tears down JUST the bridge (its listeners + effect) for the HMR test.
  harness.acpFiber = await ctx.plugin({
    name: 'acp-test',
    // Use the bridge's REAL exported `inject` so this never drifts from the
    // plugin's actual dependency list (adding a service to the bridge must not
    // require editing the harness — a hardcoded list silently broke when `tools`
    // was added). The bridge programs against the interface packages only.
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => { AcpPlugin.apply(inner, cfg) },
  })
  harness.client = new ClientSideConnection(makeClient, clientStream)

  return harness
}
