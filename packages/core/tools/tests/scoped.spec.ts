import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentId } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Mount the registry (with its systemPrompt dependency) on a fresh context. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRegistry)
  return ctx
}

/** Mint a scope whose key doubles as a minimal Agent-like object. */
async function mintAgentScope(ctx: Context, name: string): Promise<{ scope: Scope; key: Agent }> {
  const key = { id: name as AgentId } as Agent
  let scope!: Scope
  // The scoped context resolves services through the MINTING plugin's
  // dependency chain — the minter must inject what scope holders will reach
  // (in production the agent loop's inject list plays this role).
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, key }
}

function tool(name: string, reply = `ran:${name}`): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: (): Promise<ContentBlock[]> => Promise.resolve([{ type: 'text', text: reply }]),
  }
}

async function run(ctx: Context, name: string, agent?: Agent): Promise<string> {
  const result = await ctx.tools.execute({
    callId: CallId('c1'),
    name,
    arguments: {},
    ...agent ? { agent } : {},
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

describe('scoped tool registration', () => {
  it('files a scoped tool in its layer: visible/executable for that scope only', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    const other = { id: 'other' as AgentId } as Agent
    ctx.tools.register(tool('shared'))
    scope.ctx.tools.register(tool('mine'))

    expect(ctx.tools.schemas(key).map(t => t.name).sort()).toEqual(['mine', 'shared'])
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['shared'])
    expect(ctx.tools.schemas(other).map(t => t.name)).toEqual(['shared'])

    expect(await run(ctx, 'mine', key)).toBe('ran:mine')
    // Out-of-view execution is indistinguishable from a nonexistent tool.
    expect(await run(ctx, 'mine', other)).toBe('Error: unknown tool "mine"')
    expect(await run(ctx, 'mine')).toBe('Error: unknown tool "mine"')
  })

  it('scoped shadows global on a name conflict, in either registration order', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    // scoped-then-global
    scope.ctx.tools.register(tool('bash', 'restricted-bash'))
    ctx.tools.register(tool('bash', 'global-bash'))
    expect(await run(ctx, 'bash', key)).toBe('restricted-bash')
    expect(await run(ctx, 'bash')).toBe('global-bash')
    expect(ctx.tools.get('bash', key)?.description).toBe(ctx.tools.get('bash', key)?.description)
    // Exactly one 'bash' in the scope's schema view (the shadow, not a double).
    expect(ctx.tools.schemas(key).filter(t => t.name === 'bash')).toHaveLength(1)
  })

  it('rejects a duplicate name within one layer, naming agent.ctx for the global case', async () => {
    const ctx = await mount()
    const { scope } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('x'))
    expect(() => ctx.tools.register(tool('x'))).toThrow(/agent\.ctx/)
    scope.ctx.tools.register(tool('y'))
    expect(() => scope.ctx.tools.register(tool('y'))).toThrow(/already registered in this scope/)
  })

  it('disposing the scope unwinds its registrations and leaves no residue', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    scope.ctx.tools.register(tool('mine'))
    expect(ctx.tools.get('mine', key)).toBeDefined()
    await scope.dispose()
    expect(ctx.tools.get('mine', key)).toBeUndefined()
    expect(ctx.tools.knownNames(key)).toEqual([])
  })
})

describe('restrict()', () => {
  it('masks global tools for the scope; grants bypass; assembly and execute agree', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('bash'))
    scope.ctx.tools.register(tool('capture'))
    scope.ctx.tools.restrict({ allow: ['read'] })

    // The scoped grant survives the allow-list; the unlisted global is gone.
    expect(ctx.tools.schemas(key).map(t => t.name).sort()).toEqual(['capture', 'read'])
    expect(await run(ctx, 'bash', key)).toBe('Error: unknown tool "bash"')
    expect(await run(ctx, 'read', key)).toBe('ran:read')
    expect(await run(ctx, 'capture', key)).toBe('ran:capture')
    // Other scopes and the global view are untouched.
    expect(ctx.tools.schemas().map(t => t.name).sort()).toEqual(['bash', 'read'])
  })

  it('composes multiple restrictions by intersection and lifts each independently', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    for (const name of ['a', 'b', 'c']) ctx.tools.register(tool(name))
    const liftAllow = scope.ctx.tools.restrict({ allow: ['a', 'b'] })
    scope.ctx.tools.restrict({ deny: ['b'] })
    expect(ctx.tools.schemas(key).map(t => t.name)).toEqual(['a'])
    liftAllow()
    // The deny remains after the allow-list is lifted.
    expect(ctx.tools.schemas(key).map(t => t.name).sort()).toEqual(['a', 'c'])
  })

  it('snapshots the filter at registration (caller mutation changes nothing)', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('a'))
    ctx.tools.register(tool('b'))
    const filter = { deny: ['a'] }
    scope.ctx.tools.restrict(filter)
    filter.deny.push('b')
    expect(ctx.tools.schemas(key).map(t => t.name)).toEqual(['b'])
  })

  it('fails loud on an unscoped call, an empty filter, and unknown names', async () => {
    const ctx = await mount()
    const { scope } = await mintAgentScope(ctx, 'a')
    ctx.tools.register(tool('real'))
    expect(() => ctx.tools.restrict({ deny: ['real'] })).toThrow(/requires a scoped context/)
    expect(() => scope.ctx.tools.restrict({})).toThrow(/no-op/)
    expect(() => scope.ctx.tools.restrict({ allow: ['reall'] })).toThrow(/unknown tool "reall"; known tools for this scope: real/)
  })
})

describe('scoped execution dispatch', () => {
  it('an agent.ctx pre-execute listener gates only its own agent (and never subject-less calls)', async () => {
    const ctx = await mount()
    const { scope, key } = await mintAgentScope(ctx, 'a')
    const other = { id: 'other' as AgentId } as Agent
    ctx.tools.register(tool('t'))

    const seen: (string | undefined)[] = []
    scope.ctx.on('tools/pre-execute', (exec: ToolExecution, _next: () => Promise<PreToolDecision>) => {
      seen.push(exec.agent?.id)
      return Promise.resolve<PreToolDecision>({ kind: 'deny', reason: 'scoped veto' })
    })

    expect(await run(ctx, 't', key)).toBe('Error: scoped veto')
    expect(await run(ctx, 't', other)).toBe('ran:t')
    expect(await run(ctx, 't')).toBe('ran:t')
    expect(seen).toEqual(['a'])
  })
})
