/**
 * Command/skill RPC handlers and the two new frames over createApiProxy:
 * command.list serves the addressed agent's effective catalog (missing
 * registry = loud internal error), command.execute dispatches through the
 * registry with the carrier signal, skill.list resolves cwd from the session
 * header (never via the Agent registry), the host stream broadcasts
 * commands-changed, and the mux stream carries live queued frames plus the
 * open-time queue snapshot.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { AgentMessageId } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentMessage } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import CommandService from '@deepseek-ai/dsh-commands'
import SkillService from '@deepseek-ai/dsh-skill'
import type { HostFrame, MuxFrame } from '../src/api/index.ts'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' }

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}
let nextRpc = 1

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): { code: string; message: string } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** Composition floor for the command/skill paths (no LLM, no persistence). */
async function harness(options: { commands?: boolean; skills?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  if (options.skills !== false) await ctx.plugin(SkillService, {})
  if (options.commands !== false) await ctx.plugin(CommandService)
  // Host-stream opener reads the committed-workspace baseline; the stub
  // suffices here — the real workspace composition is api-proxy-workspace.spec's.
  ctx.provide('workspace', { list: () => [] } as never)
  return ctx
}

/** Register a live structural agent stub (api-proxy-view precedent: only id/session/status/ctx are read). */
function stubAgent(ctx: Context, sessionId?: SessionId): Agent {
  const session = ctx.sessions.create(sessionId)
  const agent = { id: session.id, session, status: 'idle', ctx } as Agent
  ctx.agents.register(agent)
  return agent
}

/** Drain `count` frames from a stream, then abort it. */
async function collect<F>(iterable: AsyncIterable<RpcRequest<F>>, count: number, abort: AbortController): Promise<F[]> {
  const frames: F[] = []
  for await (const frame of iterable) {
    frames.push(frame.payload)
    if (frames.length >= count) abort.abort()
  }
  return frames
}

describe('command.list', () => {
  it('serves the addressed agent\'s name-sorted catalog', async () => {
    const ctx = await harness()
    ctx.commands.register({ name: 'zeta', description: 'z', handler: () => ({ kind: 'success' }) })
    ctx.commands.register({ name: 'alpha', description: 'a', input: { hint: '<x>' }, handler: () => ({ kind: 'success' }) })
    const api = createApiProxy(ctx, DEFAULTS)
    const agent = stubAgent(ctx)
    const value = expectOk(await api.commands.list(request({ sessionId: agent.id })))
    expect(value.commands).toEqual([
      { name: 'alpha', description: 'a', input: { hint: '<x>' } },
      { name: 'zeta', description: 'z' },
    ])
  })

  it('fails loud with internal when the command registry is not mounted', async () => {
    const ctx = await harness({ commands: false })
    const api = createApiProxy(ctx, DEFAULTS)
    const error = expectErr(await api.commands.list(request({ sessionId: 's' as SessionId })))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('command registry')
  })
})

describe('command.execute', () => {
  it('executes a known command against the addressed agent and detaches the result', async () => {
    const ctx = await harness()
    let received: string | undefined
    ctx.commands.register({
      name: 'goal',
      description: 'set goal',
      handler: (invocation) => {
        received = invocation.rawInput
        return { kind: 'success', text: `goal:${invocation.agent.id}` }
      },
    })
    const api = createApiProxy(ctx, DEFAULTS)
    const agent = stubAgent(ctx)
    const value = expectOk(await api.commands.execute(request({ sessionId: agent.id, line: '/goal ship it' }), new AbortController().signal))
    expect(value).toMatchObject({ matched: true })
    expect(value.commandId).toBeTruthy()
    expect(received).toBe(' ship it')
    // Pure admission on the wire: the outcome rides the durably logged
    // lifecycle pair instead of the response.
    const lifecycle = agent.session.events.filter(e => e.type === 'command/run' || e.type === 'command/done')
    expect(lifecycle).toMatchObject([
      { type: 'command/run', data: { commandId: value.commandId, name: 'goal', args: ' ship it' } },
      { type: 'command/done', data: { commandId: value.commandId, kind: 'success', text: `goal:${agent.id}` } },
    ])
  })

  it('returns matched:false when syntax or name does not resolve', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const agent = stubAgent(ctx)
    const signal = new AbortController().signal
    expect(expectOk(await api.commands.execute(request({ sessionId: agent.id, line: '/unknown' }), signal))).toEqual({ matched: false })
    expect(expectOk(await api.commands.execute(request({ sessionId: agent.id, line: 'not a command' }), signal))).toEqual({ matched: false })
  })

  it('maps a session miss to session-not-found and a registry gap to internal', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const missing = expectErr(await api.commands.execute(
      request({ sessionId: 'session-nope' as SessionId, line: '/x' }), new AbortController().signal))
    expect(missing.code).toBe('internal') // no persistence configured: resume fails loud past the gate

    const bare = await harness({ commands: false })
    const bareApi = createApiProxy(bare, DEFAULTS)
    expect(expectErr(await bareApi.commands.execute(
      request({ sessionId: 's' as SessionId, line: '/x' }), new AbortController().signal)).code).toBe('internal')
  })

  it('reports an aborted handler as cancelled and a throwing handler as internal', async () => {
    const ctx = await harness()
    ctx.commands.register({
      name: 'hang',
      description: 'never settles on its own',
      handler: () => new Promise(() => { /* settled only by abort */ }),
    })
    ctx.commands.register({
      name: 'boom',
      description: 'throws',
      handler: () => { throw new Error('kaboom') },
    })
    const api = createApiProxy(ctx, DEFAULTS)
    const agent = stubAgent(ctx)

    const controller = new AbortController()
    const pending = api.commands.execute(request({ sessionId: agent.id, line: '/hang' }), controller.signal)
    controller.abort()
    expect(expectErr(await pending).code).toBe('cancelled')

    const thrown = expectErr(await api.commands.execute(request({ sessionId: agent.id, line: '/boom' }), new AbortController().signal))
    expect(thrown.code).toBe('internal')
    expect(thrown.message).toContain('kaboom')
  })
})

describe('skill.list', () => {
  it('lists skills for the session cwd taken from the header', async () => {
    const ctx = await harness()
    const seenCwds: (string | undefined)[] = []
    ctx.skills.registerProvider({
      name: 'probe',
      list: (options) => {
        seenCwds.push(options.cwd)
        return Promise.resolve([{
          name: 'commit-helper', description: 'Git commits', whenToUse: 'when committing',
          source: 'custom', provider: 'probe', rank: 0, locator: null,
        }])
      },
      get: () => Promise.resolve(undefined),
    })
    const api = createApiProxy(ctx, DEFAULTS)
    // No agent is registered for this session: header resolution must not
    // touch (or resume through) the Agent registry.
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/proj' } })
    const value = expectOk(await api.skills.list(request({ sessionId: session.id })))
    expect(value.skills).toEqual([{ name: 'commit-helper', description: 'Git commits', whenToUse: 'when committing' }])
    expect(seenCwds).toEqual(['/proj'])
    expect(ctx.agents.get(session.id)).toBeUndefined()
  })

  it('fails loud on an unattached session id (business error, no resume attempt)', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const error = expectErr(await api.skills.list(request({ sessionId: 'session-cold' as SessionId })))
    expect(error.code).toBe('session-not-found')
  })

  it('fails loud with internal when the skill registry is not mounted', async () => {
    const ctx = await harness({ skills: false })
    const api = createApiProxy(ctx, DEFAULTS)
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/proj' } })
    const error = expectErr(await api.skills.list(request({ sessionId: session.id })))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('skill registry is absent')
  })

  it('folds a provider failure into internal', async () => {
    const ctx = await harness()
    ctx.skills.registerProvider({
      name: 'broken',
      list: () => Promise.reject(new Error('directory exploded')),
      get: () => Promise.resolve(undefined),
    })
    const api = createApiProxy(ctx, DEFAULTS)
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/proj' } })
    const response = await api.skills.list(request({ sessionId: session.id }))
    // dsh-skill contains one provider's failure (logs and serves the rest), so
    // this surfaces as an empty ok catalog rather than an error.
    const value = expectOk(response)
    expect(value.skills).toEqual([])
  })
})

describe('host/commands-changed frame', () => {
  it('broadcasts on registry change', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const abort = new AbortController()
    const stream = api.events.host({ rpcId: RpcId('t-host'), payload: {} }, abort.signal)
    const collected = collect<HostFrame>(stream, 1, abort)
    ctx.commands.register({ name: 'late', description: 'l', handler: () => ({ kind: 'success' }) })
    expect(await collected).toEqual([{ type: 'host/commands-changed' }])
  })
})

/** Build one frozen inbox message for the live `agent/inbox/*` events. */
function inboxMessage(id: string, text: string, rpcId?: string): AgentMessage {
  return Object.freeze({
    id: AgentMessageId(id),
    content: [{ type: 'text' as const, text }],
    source: rpcId === undefined ? { kind: 'user' as const } : { kind: 'user' as const, rpcId: RpcId(rpcId) },
  })
}

describe('session/queued frames', () => {
  it('forwards live enqueue events and replays the snapshot on a later mux open', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const agent = stubAgent(ctx)
    const live = new AbortController()
    const liveStream = api.events.mux({ rpcId: RpcId('t-mux-live'), payload: {} }, live.signal)
    // subscribed baseline + 2 queued frames
    const liveCollected = collect<MuxFrame>(liveStream, 3, live)

    const queued = inboxMessage('m-1', 'queued prompt')
    const steering = inboxMessage('m-2', 'queued prompt')
    ctx.emit('agent/inbox/enqueue', agent, queued, 'queued')
    ctx.emit('agent/inbox/enqueue', agent, steering, 'steering')

    const liveFrames = (await liveCollected).filter(f => f.type === 'session/queued')
    expect(liveFrames).toEqual([
      { type: 'session/queued', sessionId: agent.id, content: queued.content, source: { kind: 'user' }, steering: false },
      { type: 'session/queued', sessionId: agent.id, content: steering.content, source: { kind: 'user' }, steering: true },
    ])

    // A fresh mux connection replays the still-pending entries as its baseline.
    const replay = new AbortController()
    const replayFrames = await collect<MuxFrame>(
      api.events.mux({ rpcId: RpcId('t-mux-replay'), payload: {} }, replay.signal), 3, replay)
    expect(replayFrames.filter(f => f.type === 'session/queued')).toEqual(liveFrames)
  })

  it('retires mirror entries on their terminal dequeue', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const agent = stubAgent(ctx)
    const queued = inboxMessage('m-3', 'x')
    const steering = inboxMessage('m-4', 'x', 'r-1')
    ctx.emit('agent/inbox/enqueue', agent, queued, 'queued')
    ctx.emit('agent/inbox/enqueue', agent, steering, 'steering')
    ctx.emit('agent/inbox/dequeue', agent, queued)
    ctx.emit('agent/inbox/dequeue', agent, steering)

    const abort = new AbortController()
    const frames = await collect<MuxFrame>(
      api.events.mux({ rpcId: RpcId('t-mux-after'), payload: {} }, abort.signal), 1, abort)
    expect(frames.filter(f => f.type === 'session/queued')).toHaveLength(0)
  })

  it('retires mirror entries on a batch discard (cancel path)', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const agent = stubAgent(ctx)
    const doomed = inboxMessage('m-5', 'doomed')
    const survivor = inboxMessage('m-6', 'survivor')
    ctx.emit('agent/inbox/enqueue', agent, doomed, 'queued')
    ctx.emit('agent/inbox/enqueue', agent, survivor, 'queued')
    ctx.emit('agent/inbox/discard', agent, [doomed])

    const abort = new AbortController()
    const frames = await collect<MuxFrame>(
      api.events.mux({ rpcId: RpcId('t-mux-swept'), payload: {} }, abort.signal), 2, abort)
    const remaining = frames.filter(f => f.type === 'session/queued')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ content: survivor.content })
  })
})
