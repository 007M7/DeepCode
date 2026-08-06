/**
 * The launcher-to-app command line over a REAL Loader tree: a startup row parses the
 * invocation's inner arguments and releases the rows waiting for it, waiting rows start
 * with the resolved values, `--help` leaves the app unstarted, and a
 * bundle whose patch and startup plugin disagree fails loud.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import { afterEach, describe, expect, it } from 'vitest'
import { internals, overrideConfig, provideCmdline, runStartup, type RowChange, type StartupPlan } from '../src/index.ts'

/** Every value one boot of the fixture tree observed. */
interface Observed {
  applied: { id: string; config: Record<string, unknown> }[]
  exits: number[]
  out: string
}

/** A booted fixture tree: what it observed, and its root for direct startup calls. */
interface Fixture {
  observed: Observed
  ctx: Context
  /** Patches the startup row handed the launcher for later compositions. */
  contributed: unknown[]
}

/** Cordis FiberState.ACTIVE, mirrored because the const enum has no runtime object. */
const FIBER_ACTIVE = 2

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/** The fixture's flag family: one `--port` over the waiting row's composed config. */
function demoCommand(): Command {
  return new Command().name('demo').exitOverride().option('--port <port>', 'listen port')
}

/** The fixture's plan: `--port` overrides the waiting row, absent leaves it composed. */
const demoPlan: StartupPlan = (program, rows) => {
  const port = program.opts<{ port?: string }>().port
  if (port === undefined) return new Map()
  if (!/^\d+$/.test(port)) program.error(`error: --port must be a number, got ${JSON.stringify(port)}`)
  const row = rows.find(candidate => candidate.id === 'waiting')
  return new Map(row === undefined ? [] : [['waiting', overrideConfig(row, { port: Number(port) })]])
}

/**
 * Mount a tree with one waiting row, and — unless the caller drives startup
 * itself — a startup row that calls {@link runStartup} on this package's real
 * code path.
 * @param args - the invocation's inner arguments.
 * @param options - fixture knobs for the shapes a bundle patch can produce.
 * @returns the booted fixture.
 */
async function bootFixture(
  args: string[],
  options: { injectObjectForm?: boolean; withoutStartupRow?: boolean; slowWaitingImport?: boolean } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cmdline-'))
  const observed: Observed = { applied: [], exits: [], out: '' }
  writeFileSync(join(dir, 'waiting.mjs'), `
${options.slowWaitingImport === true ? 'await new Promise(resolve => setTimeout(resolve, 30))' : ''}
export const name = 'waiting'
export function apply(ctx, config) { globalThis.__observed.applied.push({ id: 'waiting', config }) }
`)
  // The Loader imports a row through Node's own resolver, which cannot resolve
  // this workspace's sources; the row delegates to the real function the test
  // imported through the source-plane path mapping.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'startup'
export const inject = ['cmdlineArgs']
export function apply(ctx) { return globalThis.__runStartup(ctx) }
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: waiting',
    `  name: ${pathToFileURL(join(dir, 'waiting.mjs')).href}`,
    options.injectObjectForm === true ? '  inject: { demoStartup: null }' : '  inject: [demoStartup]',
    '  config:',
    '    port: 3080',
    '    host: 127.0.0.1',
    ...options.withoutStartupRow === true ? [] : [
      '- id: startup',
      `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    ],
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as { __observed: Observed; __runStartup: (ctx: Context) => Promise<void> }
  globals.__observed = observed
  globals.__runStartup = (ctx: Context) => runStartup(ctx, 'demoStartup', demoCommand(), demoPlan)

  const contributed: unknown[] = []
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, {
    args,
    exit: code => void observed.exits.push(code),
    contribute: patches => void contributed.push(...patches),
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { observed, ctx, contributed }
}

describe('runStartup', () => {
  it('starts a waiting row only after the startup service arrives, with the flag value applied over its composed config', async () => {
    const { observed } = await bootFixture(['--port', '8080'])
    expect(observed.applied).toEqual([{ id: 'waiting', config: { port: 8080, host: '127.0.0.1' } }])
    expect(observed.exits).toEqual([])
  })

  it('starts the waiting row unchanged when the invocation carries no flags', async () => {
    const { observed } = await bootFixture([])
    expect(observed.applied).toEqual([{ id: 'waiting', config: { port: 3080, host: '127.0.0.1' } }])
  })

  it('applies the flag value to a row whose own mount was still in flight', async () => {
    // The row has no fiber yet when startup disables it, so the disable is not
    // a barrier: the in-flight mount still produces one. Without disposing
    // that late fiber, the row would start on its composed port.
    const { observed } = await bootFixture(['--port', '8080'], { slowWaitingImport: true })
    expect(observed.applied).toEqual([{ id: 'waiting', config: { port: 8080, host: '127.0.0.1' } }])
  })

  it('starts a row that injects the startup service in the intercept-map form of inject', async () => {
    const { observed } = await bootFixture(['--port', '8080'], { injectObjectForm: true })
    expect(observed.applied).toEqual([{ id: 'waiting', config: { port: 8080, host: '127.0.0.1' } }])
  })

  it('prints the app help, leaves the app unstarted, and requests exit 0', async () => {
    const { observed } = await bootFixture(['--help'])
    expect(observed.out).toContain('Usage: demo')
    expect(observed.applied).toEqual([])
    expect(observed.exits).toEqual([0])
  })

  it('rejects the invocation from the plan without starting the app', async () => {
    const { observed } = await bootFixture(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(observed.applied).toEqual([])
    expect(observed.exits).toEqual([1])
  })
})

describe('startup-service lifetime', () => {
  it('unloads the waiting rows when the startup row is disposed, and reopens on a fresh run', async () => {
    // The startup service is an effect of the startup row: HMR restarting that
    // row must take its app down with it, then bring it back.
    const { ctx, observed } = await bootFixture(['--port', '8080'])
    const startup = [...ctx.loader.entries()].find(entry => entry.options.id === 'startup')
    const waiting = [...ctx.loader.entries()].find(entry => entry.options.id === 'waiting')
    expect(waiting?.fiber?.state).toBe(FIBER_ACTIVE)
    await startup?.update({ disabled: true })
    expect(waiting?.fiber?.state).not.toBe(FIBER_ACTIVE)
    await startup?.update({ disabled: false })
    await ctx.loader.await()
    expect(waiting?.fiber?.state).toBe(FIBER_ACTIVE)
    // The second run re-resolved the same arguments, so the row is back on the
    // flag value rather than the composed one.
    expect(observed.applied.at(-1)).toEqual({ id: 'waiting', config: { port: 8080, host: '127.0.0.1' } })
  })
})

describe('runStartup rejects a bundle that disagrees with its own patch', () => {
  it('fails when no row declares the startup service it provides', async () => {
    // The patch and its startup plugin disagree; a silent no-op would leave
    // the app's rows waiting forever with no explanation.
    const { ctx } = await bootFixture([], { withoutStartupRow: true })
    await expect(runStartup(ctx, 'absentStartup', demoCommand(), demoPlan))
      .rejects.toThrow('absentStartup: no row injects this startup service')
  })

  it('fails when the plan names a row that is not waiting', async () => {
    const { ctx, observed } = await bootFixture([], { withoutStartupRow: true })
    const plan: StartupPlan = () => new Map<string, RowChange>([['not-waiting', {}]])
    await expect(runStartup(ctx, 'demoStartup', demoCommand(), plan))
      .rejects.toThrow('startup planned changes for row(s) not-waiting')
    expect(observed.applied).toEqual([])
  })

  it('rethrows a plan failure that is not commander asking to exit', async () => {
    const { ctx, observed } = await bootFixture([], { withoutStartupRow: true })
    const plan: StartupPlan = () => { throw new Error('plan exploded') }
    await expect(runStartup(ctx, 'demoStartup', demoCommand(), plan)).rejects.toThrow('plan exploded')
    expect(observed.exits).toEqual([])
  })

  it('rethrows a thrown value that is not an object at all', async () => {
    const { ctx } = await bootFixture([], { withoutStartupRow: true })
    const plan: StartupPlan = () => {
      const thrown: unknown = 'plan threw a string'
      throw thrown
    }
    await expect(runStartup(ctx, 'demoStartup', demoCommand(), plan)).rejects.toThrow('plan threw a string')
  })
})

describe('the launcher patch layer', () => {
  it('hands the startup row\'s decisions to the launcher as patches', async () => {
    const { contributed } = await bootFixture(['--port', '8080'])
    // The same decisions the rows started with: a launcher that recomposes its
    // tree re-applies these, so an unrelated user edit cannot reset the port.
    expect(contributed).toEqual([
      { id: 'waiting', disabled: false, config: { port: 8080, host: '127.0.0.1' } },
    ])
  })

  it('contributes nothing when the invocation decided nothing', async () => {
    const { contributed } = await bootFixture([])
    expect(contributed).toEqual([])
  })
})

describe('an app with nothing to decide', () => {
  it('starts every waiting row unchanged when it declares no plan', async () => {
    const { ctx, observed } = await bootFixture([], { withoutStartupRow: true })
    // The list form of the service argument, which an app layering over
    // another one uses to absorb that app's startup service.
    await runStartup(ctx, ['demoStartup'], demoCommand())
    expect(observed.applied).toEqual([{ id: 'waiting', config: { port: 3080, host: '127.0.0.1' } }])
  })

  it('overrides a row that carries no composed config', () => {
    expect(overrideConfig({ id: 'row', name: 'plugin' }, { port: 8080 })).toEqual({ config: { port: 8080 } })
  })
})

describe('provideCmdline', () => {
  it('hands the app a snapshot the caller cannot mutate afterwards', () => {
    const ctx = new Context()
    const args = ['--resume', 'abc']
    provideCmdline(ctx, { args, exit: () => {} })
    args.push('--tampered')
    expect(ctx.cmdlineArgs?.get()).toEqual(['--resume', 'abc'])
  })

  it('fails loud when a startup row runs without the launcher values', async () => {
    const ctx = new Context()
    await expect(runStartup(ctx, 'demoStartup', demoCommand()))
      .rejects.toThrow('the launcher must provide ctx.cmdlineArgs and ctx.appExit')
  })

  it('opens nothing, and blames nobody, when the tree was disposed while startup was parsing', async () => {
    // An early SIGTERM disposes the Loader mid-parse. There is nothing left to
    // open, and the bundle did nothing wrong.
    const exits: number[] = []
    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: code => void exits.push(code) })
    await expect(runStartup(ctx, 'demoStartup', demoCommand())).resolves.toBeUndefined()
    expect(exits).toEqual([])
  })
})
