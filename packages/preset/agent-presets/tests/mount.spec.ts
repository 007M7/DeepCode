import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { beforeEach, describe, expect, it } from 'vitest'
import AgentPresets, {
  COMPOSITION_FILE, leakedServices, livePresetMounts, mountPreset, serviceForAgent,
} from '@deepseek-ai/dsh-agent-presets'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'

declare module 'cordis' {
  interface Context {
    /** Published by the `isolated` fixture preset behind an entry-local realm. */
    fixtureIsolatedSvc: { label: string }
  }
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]

/** A composition carrying the registries a preset contributes to, plus the preset roster. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'standard', roots: ROOTS })
  return ctx
}

/** Create one agent composed from `presetId`, exactly as a factory `setup` would. */
async function agentOn(ctx: Context, id: string, presetId?: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

/** Every service registration in the runtime, regardless of which realm holds it. */
function providedServiceNames(ctx: Context): string[] {
  const store = ctx.reflect.store
  return Object.getOwnPropertySymbols(store)
    .map(key => store[key]?.name)
    .filter((name): name is string => name !== undefined)
}

/** Whether the root realm maps `name` to a live registration. */
function rootResolves(ctx: Context, name: string): boolean {
  const key = ctx.root[Context.isolate][name]
  return key !== undefined && ctx.reflect.store[key] !== undefined
}

let ctx: Context
beforeEach(async () => {
  ctx = await harness()
})

describe('composing an agent from a preset', () => {
  it('gives each session only its own preset\'s tools', async () => {
    const alpha = await agentOn(ctx, 'sess-alpha', 'standard')
    const beta = await agentOn(ctx, 'sess-beta', 'minimal')

    expect(toolNames(ctx, alpha)).toEqual(['alpha'])
    expect(toolNames(ctx, beta)).toEqual(['beta'])
    expect(toolNames(ctx)).toEqual([])
  })

  it('scopes prompt sections and assembled schemas to the same session', async () => {
    const alpha = await agentOn(ctx, 'sess-alpha', 'standard')
    const beta = await agentOn(ctx, 'sess-beta', 'minimal')

    const alphaPrompt = await ctx.systemPrompt.assemble(assembleContextFor(alpha))
    const betaPrompt = await ctx.systemPrompt.assemble(assembleContextFor(beta))

    expect(alphaPrompt.sections.map(section => section.name)).toContain('preset:alpha')
    expect(alphaPrompt.sections.map(section => section.name)).not.toContain('preset:beta')
    expect(betaPrompt.sections.map(section => section.name)).toContain('preset:beta')
    expect(alphaPrompt.tools.map(schema => schema.name)).toEqual(['alpha'])
  })

  it('mounts the default preset when the caller names none', async () => {
    const agent = await agentOn(ctx, 'sess-default')

    expect(toolNames(ctx, agent)).toEqual(['alpha'])
  })

  it('lets two sessions share one preset without colliding', async () => {
    const first = await agentOn(ctx, 'sess-first', 'standard')
    const second = await agentOn(ctx, 'sess-second', 'standard')

    expect(toolNames(ctx, first)).toEqual(['alpha'])
    expect(toolNames(ctx, second)).toEqual(['alpha'])
  })

  it('unwinds one session\'s composition without touching another\'s', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-gone'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const survivor = await agentOn(ctx, 'sess-stays', 'minimal')
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])

    await handle.dispose()

    expect(ctx.agents.get(SessionId('sess-gone'))).toBeUndefined()
    expect(toolNames(ctx, survivor)).toEqual(['beta'])
    expect(toolNames(ctx)).toEqual([])
  })
})

describe('rejecting a composition that cannot be used', () => {
  it('refuses to mount into a context that carries no agent scope', async () => {
    await expect(ctx.agentPresets.mount(ctx, 'standard'))
      .rejects.toThrow(/unscoped context/)
  })

  it('rolls the whole agent back when a row fails to load', async () => {
    await expect(agentOn(ctx, 'sess-broken', 'broken')).rejects.toThrow(/failed to mount/)

    expect(ctx.agents.get(SessionId('sess-broken'))).toBeUndefined()
    expect(toolNames(ctx)).toEqual([])
  })

  it('names the unresolved service when a row never activates', async () => {
    await expect(agentOn(ctx, 'sess-pending', 'pending'))
      .rejects.toThrow(/waiting for serviceThatDoesNotExist/)
  })

  it('rejects a row that publishes a process-global service', async () => {
    await expect(agentOn(ctx, 'sess-leaky', 'leaky'))
      .rejects.toThrow(/process-global service\(s\) \[aaaFixtureLeakedSvc, zzzFixtureLeakedSvc\]/)

    // The rejected subtree is fully unwound, so its registrations are gone from
    // the store rather than merely unreachable.
    expect(providedServiceNames(ctx)).not.toContain('aaaFixtureLeakedSvc')
    expect(providedServiceNames(ctx)).not.toContain('zzzFixtureLeakedSvc')
  })

  it('accepts the same provider behind an isolate realm', async () => {
    const agent = await agentOn(ctx, 'sess-isolated', 'isolated')

    expect(agent.id).toBe(SessionId('sess-isolated'))
    // The provider ran, but under a realm-private symbol the root cannot reach.
    expect(providedServiceNames(ctx)).toContain('fixtureIsolatedSvc')
    expect(rootResolves(ctx, 'fixtureIsolatedSvc')).toBe(false)
  })

  it('addresses the standing instance of a realm-private service through either agent', async () => {
    const first = await agentOn(ctx, 'sess-reach-a', 'isolated')
    const second = await agentOn(ctx, 'sess-reach-b', 'isolated')

    // The realm keeps the service out of every host context, so a caller
    // holding the agent is how a request from OUTSIDE the session reads the
    // instance it is about.
    expect(rootResolves(ctx, 'fixtureIsolatedSvc')).toBe(false)
    const mine = ctx.agentPresets.serviceFor(first, 'fixtureIsolatedSvc')
    const theirs = ctx.agentPresets.serviceFor(second, 'fixtureIsolatedSvc')
    expect(mine).toBeDefined()
    // ONE composition per preset: both agents joined the same standing mount,
    // so they address the same instance — sessions stay apart inside it by
    // the plugin's own Session/Agent keying, not by instance count.
    expect(theirs).toBe(mine)
  })

  it('answers undefined for a service the agent\'s preset does not mount', async () => {
    // The isolated preset's standing instance exists in the same runtime, so
    // the lookup finds the NAME and must still refuse it: the instance lives
    // under another mount's fiber, not this agent's composition.
    await agentOn(ctx, 'sess-reach-other', 'isolated')
    const agent = await agentOn(ctx, 'sess-reach-none', 'standard')

    expect(ctx.agentPresets.serviceFor(agent, 'fixtureIsolatedSvc')).toBeUndefined()
  })

  it('answers undefined for an agent outside the scope machinery', async () => {
    // Unscoped, scoped-but-unparented, and parented to a key no live mount
    // owns are the three ways a context can fail to name a standing mount;
    // each is an answer, not a throw, because the caller asked a question.
    expect(serviceForAgent(ctx, { ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
    const loner = createScope(ctx, { test: 'loner' })
    expect(serviceForAgent(ctx, { ctx: loner.ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
    const orphan = createScope(ctx, { test: 'orphan' })
    bindScopeParent(scopeOf(orphan.ctx)!, { agentPreset: 'never-mounted' })
    expect(serviceForAgent(ctx, { ctx: orphan.ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
  })

  it('refuses to mount a preset directly into an unscoped context', async () => {
    // The service's own mount() guards this before delegating; the exported
    // function is callable on its own, so the boundary holds there too.
    const preset = await ctx.agentPresets.resolve('standard')

    await expect(mountPreset(ctx, preset)).rejects.toThrow(/unscoped context/)
  })

  it('hands a host reader the standing key without starting an agent', async () => {
    const key = await ctx.agentPresets.standingKeyFor('minimal')

    // The mount exists for the reader; no agent, session, or turn started.
    expect(key).toEqual({ agentPreset: 'minimal' })
    expect(ctx.agents.get(SessionId('minimal'))).toBeUndefined()
    // A second reader resolves the same generation, not a new mount.
    expect(await ctx.agentPresets.standingKeyFor('minimal')).toBe(key)
  })

  it('reports the known ids when a preset is unknown', async () => {
    await expect(ctx.agentPresets.resolve('nope'))
      .rejects.toThrow(/preset "nope" not found \(available: .*standard/)
  })
})

describe('the preset roster', () => {
  it('lists every root\'s presets with the earlier root winning', async () => {
    const listed = await ctx.agentPresets.list()

    expect(listed.map(preset => preset.id).sort())
      .toEqual(['broken', 'isolated', 'late', 'leaky', 'minimal', 'pending', 'standard'])
    expect(listed.find(preset => preset.id === 'standard')?.trust).toBe('system')
  })

  it('exposes the configured default id', () => {
    expect(ctx.agentPresets.defaultId).toBe('standard')
  })
})

describe('a roster with nothing in it', () => {
  it('says so instead of naming an empty list of candidates', async () => {
    const bare = new Context()
    await bare.plugin(Loader)
    await bare.plugin(AgentPresets, { default: 'standard', roots: [] })

    await expect(bare.agentPresets.resolve())
      .rejects.toThrow(/preset "standard" not found \(available: none\)/)
  })
})

describe('the preset file is an input, never a persistence target', () => {
  it('survives a row that disposes itself, which makes the Loader persist a tree', async () => {
    // The preset lives in a temp root, not under `fixtures/`: without the
    // `write()` override the Loader REWRITES the composition it read, so a
    // committed fixture would be mutated by the very run that proves the bug
    // and every later run would compare against the damaged file and pass.
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-write-'))
    const dir = join(root, 'self-disposing')
    await mkdir(dir)
    const path = join(dir, COMPOSITION_FILE)
    const composition = [
      '- id: tool-kept',
      `  name: ${join(FIXTURES, 'plugins', 'contribute.js')}`,
      '  config:',
      '    tool: kept',
      '- id: goes-away',
      `  name: ${join(FIXTURES, 'plugins', 'self-dispose.js')}`,
      '',
    ].join('\n')
    await writeFile(path, composition)

    const scoped = new Context()
    scoped.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await scoped.plugin(Loader)
    scoped.loader.builtins.include = Include
    await scoped.plugin(LlmService)
    await scoped.plugin(SessionStore)
    await scoped.plugin(SystemPrompt, { persona: '' })
    await scoped.plugin(ToolRegistry)
    await scoped.plugin(AgentRegistry)
    await scoped.plugin(AgentLoop, { agents: [] })
    await scoped.plugin(AgentPresets, { default: 'self-disposing', roots: [{ path: root, trust: 'user' as const }] })

    await scoped.agents.create({
      sessionId: SessionId('sess-self-dispose'),
      setup: async (agentCtx: Context) => void await scoped.agentPresets.mount(agentCtx),
    })
    await (globalThis as { __SELF_DISPOSED__?: Promise<unknown> }).__SELF_DISPOSED__
    // Slack past the deterministic signal above, not a race the number has to
    // win. The write rides the Loader's fiber-unload listener, which stamps
    // `disabled: true` and calls `write()` in the same synchronous step; once
    // the self-dispose has settled, a regression has already written. Polling
    // would not help — the assertion is an ABSENCE, and no amount of waiting
    // proves one — so the wait only has to clear settlement.
    await new Promise(resolve => setTimeout(resolve, 50))

    // Inherited, `EntryTree.write()` persists the dying tree — stamping
    // `disabled: true` onto the row and, in the shipped case, truncating the
    // composition every session shares.
    expect(await readFile(path, 'utf8')).toBe(composition)
  })
})

describe('attributing a service to a subtree', () => {
  it('attributes nothing to a subtree that is already torn down', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-torn'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const [mount] = livePresetMounts().filter(entry => entry.presetId === 'standard')
    expect(mount).toBeDefined()

    await handle.dispose()

    // A disposed subtree owns nothing, so it can never be blamed for a service
    // some other subtree published under the same name afterwards.
    expect(leakedServices(ctx, mount!.fiber)).toEqual([])
  })
})

