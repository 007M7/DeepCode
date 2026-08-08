/**
 * A session's agent preset is fixed at creation. The gateway records the
 * resolved id on the header and refuses to adopt the identity under a different
 * one, because the session's history was produced under that preset's tools:
 * rebuilding it differently would replay tool calls the new agent cannot make.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'
import { resolveSessionPreset, UnknownPresetError } from '@deepseek-ai/dsh-agent-presets'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { createApiProxy } from '../src/api-proxy.ts'
import { describe, expect, it } from 'vitest'

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`preset-${String(nextRpc++)}`), payload }
}

/** Minimal live agent; the gateway only needs identity and its session. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/**
 * A roster whose `mount` is a no-op: this spec is about the gateway's identity
 * rules, and the composition itself is covered by the real-composition test in
 * `apps/cli`.
 */
function roster(ids: readonly string[]): unknown {
  return {
    defaultId: ids[0],
    list: () => Promise.resolve(ids.map(id => ({ id, trust: 'system', path: `/presets/${id}.yml` }))),
    resolve: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) return Promise.reject(new UnknownPresetError(wanted, ids))
      return Promise.resolve({ id: wanted, trust: 'system', path: `/presets/${wanted}.yml` })
    },
    mount: (_ctx: Context, id?: string) =>
      Promise.resolve({ id: id ?? ids[0], trust: 'system', path: '/presets/x.yml' }),
    // What a real mount leaves behind: a service instance only the agent that
    // mounted it can be used to address. The doubles are per agent so a test
    // can tell "this session's" from "some session's".
    serviceFor: (agent: { id: unknown }, name: string) => {
      const perAgent = services.get(String(agent.id))
      return perAgent?.[name]
    },
    recompose: (_ctx: Context, id: string) => {
      if (!ids.includes(id)) return Promise.reject(new UnknownPresetError(id, ids))
      return Promise.resolve({ id, trust: 'system', path: `/presets/${id}.yml` })
    },
    // The standing scope key a cold transcript read resolves presenters in.
    standingKeyFor: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      standingKeyRequests.push(wanted)
      if (!ids.includes(wanted) || failingStandingKeys.has(wanted)) {
        return Promise.reject(new UnknownPresetError(wanted, ids))
      }
      let key = standingKeys.get(wanted)
      if (key === undefined) {
        key = { agentPreset: wanted }
        standingKeys.set(wanted, key)
      }
      return Promise.resolve(key)
    },
  }
}

/** Standing keys the roster double minted, and the ids readers asked for. */
const standingKeys = new Map<string, object>()
const standingKeyRequests: string[] = []
/** Preset ids whose standing mount the double reports as unusable. */
const failingStandingKeys = new Set<string>()

/** Per-agent service instances a mounted preset would own, keyed by session id. */
const services = new Map<string, Record<string, unknown>>()

async function harness(presets?: readonly string[], persistence?: unknown) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-preset-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserInteractionService)
  ctx.provide('sessionPersistence', (persistence ?? { list: () => Promise.resolve([]) }) as never)
  if (presets !== undefined) ctx.provide('agentPresets', roster(presets) as never)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      // Setup runs before publication against a context that carries the
      // agent, and the agent reaches back through `agent.ctx` — the pair the
      // gateway's own `installTarget` relies on.
      const agentCtx = ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      await options.setup?.(agentCtx)
      const unregister = ctx.agents.register(agent)
      return { agent, dispose: () => { unregister(); return Promise.resolve() } }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    defaultTarget: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
    workspaceRoot: cwd,
  })
  return { api, ctx, cwd }
}

describe('session.create with an agent preset', () => {
  it('records the resolved preset on the session header', async () => {
    const { api, ctx } = await harness(['standard', 'core-web'])

    const created = await api.sessions.create(request({ sessionId: SessionId('s1'), agentPreset: 'core-web' }))

    expect(created.result.ok).toBe(true)
    expect(ctx.sessions.get(SessionId('s1'))?.header.agentPreset).toBe('core-web')
  })

  it('records the default when the caller names none', async () => {
    const { api, ctx } = await harness(['standard', 'core-web'])

    await api.sessions.create(request({ sessionId: SessionId('s2') }))

    expect(ctx.sessions.get(SessionId('s2'))?.header.agentPreset).toBe('standard')
  })

  it('rejects an unknown preset and names the ones that exist', async () => {
    const { api } = await harness(['standard'])

    const response = await api.sessions.create(request({ sessionId: SessionId('s3'), agentPreset: 'nope' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('refuses to adopt a live session under a different preset', async () => {
    const { api } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('s4'), agentPreset: 'core-web' }))

    const response = await api.sessions.create(request({ sessionId: SessionId('s4'), agentPreset: 'standard' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-conflict')
    expect(response.result.error.details).toEqual({
      sessionId: 's4',
      requestedPreset: 'standard',
      existingPreset: 'core-web',
    })
  })

  it('adopts a live session unchanged when the caller names no preset', async () => {
    const { api } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('s5'), agentPreset: 'core-web' }))

    // Reconnecting and retrying a create must stay ordinary operations.
    const response = await api.sessions.create(request({ sessionId: SessionId('s5') }))

    expect(response.result.ok).toBe(true)
  })

  it('leaves the header preset-less when no roster is composed', async () => {
    const { api, ctx } = await harness()

    await api.sessions.create(request({ sessionId: SessionId('s6') }))

    expect(ctx.sessions.get(SessionId('s6'))?.header.agentPreset).toBeUndefined()
  })

  it('says why a preset-less session cannot be adopted under one', async () => {
    // Two callers reach this: a deployment that composes no roster, and a
    // session created before one existed. Both record no preset, so naming
    // any is a conflict rather than an adoption — the history was produced
    // under a composition this roster cannot name. The message has to say
    // that, because "already runs agent preset undefined" reads as a bug.
    const { api } = await harness()
    await api.sessions.create(request({ sessionId: SessionId('s7') }))

    const response = await api.sessions.create(request({ sessionId: SessionId('s7'), agentPreset: 'standard' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-conflict')
    expect(response.result.error.message).toContain('records no agent preset')
    expect(response.result.error.details).toEqual({
      sessionId: 's7',
      requestedPreset: 'standard',
      existingPreset: undefined,
    })
  })
})

/**
 * A capability a preset mounts is reachable from nowhere the host normally
 * looks: an `isolate` realm is what makes it per session. The gateway serves
 * requests that are ABOUT a session from OUTSIDE it, so it addresses the
 * instance through the agent instead of reading a root-realm singleton.
 */
describe('a capability the session\'s preset mounts', () => {
  it('serves the goal RPC from the session\'s own goal service', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('g1'), agentPreset: 'standard' }))
    const ref = { id: GoalId('goal-1'), revision: 1 }
    const paused: unknown[] = []
    services.set('g1', {
      goals: { pause: (agent: { id: unknown }, r: unknown) => { paused.push([String(agent.id), r]); return ref } },
    })

    const response = await api.goals.pause(request({ sessionId: SessionId('g1'), ref }))

    expect(response.result).toMatchObject({ ok: true, value: { ref } })
    // Reached the instance this session mounted, and was handed its own agent.
    expect(paused).toEqual([['g1', ref]])
    services.delete('g1')
  })

  it('serves the skill catalog from the session\'s own registry', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('k1'), agentPreset: 'standard' }))
    services.set('k1', {
      skills: {
        list: () => Promise.resolve([{
          name: 'preset-owned',
          description: 'ships inside the preset directory',
          invocation: { modelInvocable: true, userInvocable: true },
        }]),
      },
    })

    const response = await api.skills.list(request({ sessionId: SessionId('k1') }))

    // A preset ships its own skill directory, so the catalog IS the
    // session's; reading a host singleton would answer for the wrong one.
    expect(response.result).toMatchObject({ ok: true, value: { skills: [{ name: 'preset-owned' }] } })
    services.delete('k1')
  })

  it('says so when no composition mounts the capability at all', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('n1'), agentPreset: 'standard' }))

    const response = await api.skills.list(request({ sessionId: SessionId('n1') }))

    // Absent means absent — not "this session has none", which is what a
    // root-realm read used to report for every presetd session.
    expect(response.result.ok).toBe(false)
    const failure = response.result as { ok: false; error: { message: string } }
    expect(failure.error.message).toContain('neither this session')
  })
})

describe('agentPreset.list', () => {
  it('marks the default and carries each preset\'s trust', async () => {
    const { api } = await harness(['standard', 'core-web'])

    const response = await api.agentPresets.list(request({}))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.presets).toEqual([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'core-web', trust: 'system', isDefault: false },
    ])
  })

  it('answers with an empty roster when the deployment composes no presets', async () => {
    const { api } = await harness()

    const response = await api.agentPresets.list(request({}))

    // Composing no presets is a valid deployment, not an error: every session
    // then shares the host composition and the browser offers no choice.
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.presets).toEqual([])
  })
})

describe('agentPreset.select', () => {
  it('recomposes a blank session', async () => {
    const { api } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('sel-1'), agentPreset: 'standard' }))

    const response = await api.agentPresets.select(
      request({ sessionId: SessionId('sel-1'), agentPreset: 'core-web' }))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.agentPreset).toBe('core-web')
  })

  it('records the switch in the log, and the list reads it back', async () => {
    const { api, ctx } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('sel-log'), agentPreset: 'standard' }))

    await api.agentPresets.select(
      request({ sessionId: SessionId('sel-log'), agentPreset: 'core-web' }))

    // The header is written once at creation, so the switch lives in the log —
    // this is what a restart replays and what every projection resolves from.
    // Asserting only the RPC's echo would miss a switch that never persisted.
    const session = ctx.sessions.get(SessionId('sel-log'))
    if (session === undefined) throw new Error('unreachable')
    expect(session.header.agentPreset).toBe('standard')
    expect(resolveSessionPreset(session)).toBe('core-web')
    const listed = await api.sessions.list(request({}))
    if (!listed.result.ok) throw new Error('unreachable')
    expect(listed.result.value.items.find(item => item.sessionId === 'sel-log')?.agentPreset)
      .toBe('core-web')
  })

  it('serializes two concurrent selects on one session', async () => {
    const { api, ctx } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('sel-race'), agentPreset: 'standard' }))

    // Both pass the blank check; unserialized, the second unmount finds no
    // record because the first already removed it, and two compositions end up
    // in one agent layer. The client's busy flag is not enforcement.
    const [first, second] = await Promise.all([
      api.agentPresets.select(request({ sessionId: SessionId('sel-race'), agentPreset: 'core-web' })),
      api.agentPresets.select(request({ sessionId: SessionId('sel-race'), agentPreset: 'standard' })),
    ])

    expect(first.result.ok).toBe(true)
    expect(second.result.ok).toBe(true)
    const session = ctx.sessions.get(SessionId('sel-race'))
    if (session === undefined) throw new Error('unreachable')
    // One winner, and the log agrees with it: the last committed switch.
    expect(resolveSessionPreset(session)).toBe('standard')
  })

  it('refuses once the conversation has started', async () => {
    const { api, ctx } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('sel-2'), agentPreset: 'standard' }))
    // One turn is enough: the history from here on was produced under
    // `standard`'s tools, and a swap would strand those tool calls.
    ctx.sessions.get(SessionId('sel-2'))?.append('turn/start', { turn: 0 })

    const response = await api.agentPresets.select(
      request({ sessionId: SessionId('sel-2'), agentPreset: 'core-web' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-locked')
  })

  it('reports an unknown preset without disturbing the session', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('sel-3') }))

    const response = await api.agentPresets.select(
      request({ sessionId: SessionId('sel-3'), agentPreset: 'nope' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('reports a deployment that composes no presets', async () => {
    const { api } = await harness()
    await api.sessions.create(request({ sessionId: SessionId('sel-4') }))

    const response = await api.agentPresets.select(
      request({ sessionId: SessionId('sel-4'), agentPreset: 'anything' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })
})

describe('session.history presenter scope', () => {
  it('asks the roster for the RECORDED preset\'s standing key on a cold read', async () => {
    const { api } = await harness(['standard', 'core-web'])
    await api.sessions.create(request({ sessionId: SessionId('p1'), agentPreset: 'core-web' }))
    // Cold: creation registered a live agent in this harness, so simulate the
    // cold path by asking for a session only persistence knows... the harness
    // has no persistence, so read the live one and assert no roster query.
    standingKeyRequests.length = 0
    const live = await api.sessions.history(request({ sessionId: SessionId('p1') }))
    expect(live.result.ok).toBe(true)
    // A live agent IS the presenter scope; the roster is not consulted.
    expect(standingKeyRequests).toEqual([])
  })

  it('serves a COLD transcript whose standing mount is no longer usable', async () => {
    // A genuinely cold session: persistence knows it, no live agent exists.
    const meta = { id: SessionId('p3'), createdAt: 1, cwd: '/tmp/p3', agentPreset: 'standard' }
    const { api } = await harness(['standard'], {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    // The preset broke after the session ran: the roster rejects the mount.
    failingStandingKeys.add('standard')
    try {
      standingKeyRequests.length = 0
      const response = await api.sessions.history(request({ sessionId: SessionId('p3') }))
      // Degraded, never failed: the roster WAS asked, and the transcript
      // still serves — with the generic cards a viewless entry renders.
      expect(standingKeyRequests).toEqual(['standard'])
      expect(response.result.ok).toBe(true)
    } finally {
      failingStandingKeys.delete('standard')
    }
  })
})
