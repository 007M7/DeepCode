/**
 * Shared non-spec fixture that mounts the full in-memory agent/persistence stack and connects the
 * ACP bridge to a real SDK client over memory streams. Tests exercise the same protocol path as an
 * editor without a subprocess or stdio.
 */

import { Context } from 'cordis'
import { CallId, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandService from '@deepseek-ai/dsh-commands'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-policy'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import PlanModeService from '@deepseek-ai/dsh-plan-mode'
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent as AcpAgent,
  type Client,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as AcpPlugin from '../src/index.ts'
import { type AcpConfig } from '../src/index.ts'

/** A scripted mock adapter (mirrors the agent-loop test adapter). */
class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(
    private script: (StreamChunk[] | 'hang')[],
    private readonly providers: readonly LlmProviderInfo[],
    private readonly models: readonly LlmModelInfo[],
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const info = this.providers.find(entry => entry.id === provider)
    if (info === undefined) throw new Error(`MockAdapter: unknown provider ${provider}`)
    return info
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models.filter(model => model.provider === provider))
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
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } },
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
  /** Elicitation requests the bridge issued for ask_user_question. */
  elicitationRequests: CreateElicitationRequest[]
  /** Decide each elicitation response (default: cancel). */
  onElicitation: (req: CreateElicitationRequest) => CreateElicitationResponse | Promise<CreateElicitationResponse>
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

/** Test-only overrides preserve explicit undefined to suppress harness defaults. */
type AcpConfigOverrides = { [K in keyof AcpConfig]?: AcpConfig[K] | undefined }

/**
 * Build the bridge + a connected client over an in-memory transport pair.
 *
 * Two identity `TransformStream`s cross-wired (agent writes → client reads,
 * client writes → agent reads) give a faithful bidirectional JSON-RPC channel.
 * The bridge's `apply` receives the agent-side `Stream` via `config.stream`;
 * the test holds the `ClientSideConnection`.
 *
 * Pass an explicit undefined route field to suppress its mock default.
 */
export async function makeBridgeHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: AcpConfigOverrides
  /** Provider-neutral directory exposed to ACP model-selection tests. */
  catalog?: { providers: LlmProviderInfo[]; models: LlmModelInfo[] }
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
  /** Plug the REAL `ask_user_question` tool and ACP user-interaction provider. */
  withAskUser?: boolean
  /**
   * Plug the REAL `dsh-tool-todo` tool so a test can drive `todo_write` through
   * the bridge and assert the resulting `plan` sessionUpdate — the shipping
   * tool + the bridge's own todo/write→plan mapping, not a stand-in.
   */
  withTodo?: boolean
  /** Plug the REAL `dsh-plan-mode` plugin so a test can drive the session-mode picker. */
  withModes?: boolean
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
  const catalog = options.catalog ?? {
    providers: [{ id: 'mock', name: 'Mock' }],
    models: [{ provider: 'mock', id: 'mock', name: 'Mock' }],
  }
  const adapter = new MockAdapter(options.script ?? [], catalog.providers, catalog.models)

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: options.persona ?? '' },
  })
  await ctx.plugin(CommandService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionPersistenceJsonl, { root: options.storageDir })
  await ctx.plugin(UserInteractionService)
  if (options.withAskUser) {
    await ctx.plugin(ToolAskUser)
  }
  if (options.withBash) {
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    await ctx.plugin(ToolBash)
  }
  if (options.withTodo) {
    await ctx.plugin(ToolTodo)
  }
  if (options.withModes) {
    await ctx.plugin(PlanModeService, { section: 'Test plan mode instructions.' })
  }
  if (options.withFs) {
    await ctx.plugin(LocalFileSystem, { cwd: options.fsCwd ?? options.storageDir })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(ToolFs)
  }
  ctx.llm.registerAdapter(catalog.providers.map(provider => provider.id), adapter)

  // Two identity byte pipes cross-wired into the two ndJsonStreams: bytes the agent writes flow
  // to the client's reader and vice versa. (ndJsonStream takes (output, input): the agent
  // writes to a2c and reads from c2a; the client writes to c2a and reads from a2c.) Holding the c2a
  // writer lets tests EOF the agent reader and simulate editor disconnect.
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
  const elicitationRequests: CreateElicitationRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    updates,
    sessionUpdates,
    permissionRequests,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    elicitationRequests,
    onElicitation: () => ({ action: 'cancel' }),
    onSessionUpdateError: undefined,
    client: undefined as unknown as ClientSideConnection,
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    // Close the writable the CLIENT writes to (c2a) — its readable, which the agent's
    // ndJsonStream consumes, then EOFs cleanly, so the bridge's `conn.closed` resolves and it
    // sees the client disconnect.
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
    unstable_createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
      elicitationRequests.push(params)
      return Promise.resolve(harness.onElicitation(params))
    },
  })

  // Default route fields only when the caller omitted them; explicit undefined values must survive.
  const cfg = { stream: agentStream, ...options.config } as AcpConfig
  if (!(options.config && 'provider' in options.config)) cfg.provider = 'mock'
  if (!(options.config && 'model' in options.config)) cfg.model = 'mock'
  // Mount the bridge the way production does: as a cordis plugin (via `ctx.plugin` with the
  // real `inject`), not `AcpPlugin.apply(ctx, cfg)` on the ungated root. Later JSON-RPC callbacks run
  // outside apply's injection scope, matching production and exposing missing-inject failures.
  harness.acpFiber = await ctx.plugin({
    name: 'acp-test',
    // Use the bridge's real exported `inject` so this never drifts from the plugin's actual
    // dependency list (adding a service to the bridge must not require editing the harness — a
    // hardcoded list silently broke when `tools` was added). The returned fiber permits ACP-only
    // disposal while root services remain live for HMR assertions.
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => { AcpPlugin.apply(inner, cfg) },
  })
  harness.client = new ClientSideConnection(makeClient, clientStream)

  return harness
}
