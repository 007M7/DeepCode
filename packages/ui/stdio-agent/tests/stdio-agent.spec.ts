import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import * as stdioAgent from '../src/index.ts'

/**
 * Unit coverage for the @deepseek-ai/dsh-stdio-agent app plugin: mounting it
 * composes the console logger, the agent-core spine (pre-creating the `main`
 * agent from the app config), the JSONL backend, and the readline UI in one
 * `ctx.plugin`. The forwarded `model`/`systemPrompt` reach the pre-created
 * agent; `persistenceRoot`/`welcome`/`resumeSessionId` route to their backends.
 *
 * `hmr` is NOT part of this plugin (it is a leaf entry — a Loader-only dev
 * plugin the in-process tier cannot import); the REAL Loader-path guard (export
 * shape, `unwrapExports`, the whole subprocess tree incl. `hmr`) is the keyless
 * echo smoke in `examples/echo-agent`. Here we assert the composition + config
 * forwarding the unit tier can reach.
 */
async function mount(config: stdioAgent.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(stdioAgent, config)
  // The app mounts its children inside apply() (not awaited there); let their
  // fibers settle so the spine services + the pre-created agent are ready.
  await new Promise(resolve => setTimeout(resolve, 80))
  return ctx
}

describe('dsh-stdio-agent app', () => {
  it('composes the spine + front-door cluster and pre-creates the main agent', async () => {
    const ctx = await mount({ model: 'mock', systemPrompt: 'hi', persistenceRoot: '/tmp/dsh-stdio-agent-spec' })
    // The spine services (brought up by the agent-core bundle) are all present.
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('agentLoop')).toBeDefined()
    expect(ctx.get('sessionPersistence')).toBeDefined()
    // The pre-created `main` agent the UI drives.
    expect(ctx.get('agents')?.get(AgentId('main'))).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('defaults persistenceRoot and welcome when omitted', async () => {
    // Direct apply (NOT via ctx.plugin, which validates+defaults the config
    // first) so the runtime `?? './.sessions'` / `?? 'ready.'` fallbacks on
    // apply()'s last two lines are the ones that fire — covering a
    // schema-bypassing direct-mount caller.
    const ctx = new Context()
    stdioAgent.apply(ctx, { model: 'mock', systemPrompt: 'hi' })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(ctx.get('sessionPersistence')).toBeDefined()
    expect(ctx.get('agents')?.get(AgentId('main'))).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('forwards resumeSessionId onto the pre-created agent when set', async () => {
    // A resume id defers agent creation until persistence loads; with no backing
    // session the resume is contained + logged, so no `main` agent registers —
    // the branch that maps resumeSessionId through is what this covers.
    const ctx = await mount({
      model: 'mock',
      systemPrompt: 'hi',
      persistenceRoot: '/tmp/dsh-stdio-agent-spec-resume',
      resumeSessionId: 'no-such-session',
    })
    expect(ctx.get('agents')?.get(AgentId('main'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('exposes its name and Config schema', () => {
    expect(stdioAgent.name).toBe('stdio-agent')
    expect(stdioAgent.Config).toBeDefined()
  })
})
