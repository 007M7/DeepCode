/**
 * The launcher-to-app command line over a REAL Loader tree, mounted the way a
 * profile boot mounts it: Loader holds each row until its injections are
 * active, then resolves that row's config against its injection-ready context.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import type { PatchOptions } from '@cordisjs/plugin-include'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enableRow, hasCmdlineConsumer, internals, provideCmdline, runStartup, type StartupPlan,
} from '../src/index.ts'

/** Every value one boot of the fixture tree observed. */
interface Observed {
  /** Config the reading row started with; absent means it never started. */
  started?: Record<string, unknown>
  exits: number[]
  out: string
}

/** A booted fixture tree: what it observed, and its root for direct startup calls. */
interface Fixture {
  observed: Observed
  ctx: Context
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/** The fixture app's flag family: one `--port` its rows read from the service. */
function demoCommand(): Command {
  return new Command().name('demo').exitOverride().option('--port <port>', 'listen port')
}

/** The fixture app's plan: the resolved values its rows read. */
const demoPlan: StartupPlan<{ port?: number }> = (program) => {
  const port = program.opts<{ port?: string }>().port
  if (port === undefined) return {}
  if (!/^\d+$/.test(port)) program.error(`error: --port must be a number, got ${JSON.stringify(port)}`)
  return { port: Number(port) }
}

/** A YAML `!!js` expression node, as the include parses one out of a patch file. */
const expression = (source: string): unknown => ({ __jsExpr: source })

/**
 * Mount a two-row composition the way a profile boot does: both rows at once,
 * with Loader ordering config resolution from their injections.
 * @param args - the invocation's inner arguments.
 * @param plan - the app's plan; defaults to the fixture's own.
 * @returns the booted fixture.
 */
async function bootFixture(
  args: string[],
  plan: StartupPlan = demoPlan,
  options: { objectInject?: boolean; withoutStartup?: boolean } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cmdline-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'reader.mjs'), `
export const name = 'reader'
export const inject = ['demoStartup']
export function apply(ctx, config) { globalThis.__observed.started = config }
`)
  // The Loader imports a row through Node's own resolver, which cannot resolve
  // this workspace's sources; the row delegates to the real function the test
  // imported through the source-plane path mapping.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'demo-startup'
export const inject = ['cmdlineArgs']
export function apply(ctx) { return globalThis.__runStartup(ctx) }
`)
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as { __observed: Observed; __runStartup: (ctx: Context) => void }
  globals.__observed = observed
  globals.__runStartup = (ctx: Context) => { runStartup(ctx, 'demoStartup', demoCommand(), plan) }

  // The composition, exactly as a profile delivers one: include patches whose
  // config carries `!!js` expressions.
  const composition: PatchOptions[] = [{
    insert: [
      ...options.withoutStartup === true
        ? []
        : [{ id: 'demo-startup', name: pathToFileURL(join(dir, 'startup.mjs')).href, inject: ['cmdlineArgs'] }],
      {
        id: 'reader',
        name: pathToFileURL(join(dir, 'reader.mjs')).href,
        inject: options.objectInject === true ? { demoStartup: { required: true } } : ['demoStartup'],
        config: { port: expression('ctx.demoStartup?.port ?? 3080') },
      },
    ],
  }]
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(dir, 'cordis.yml')).href, patches: structuredClone(composition) },
  })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { observed, ctx }
}

describe('hasCmdlineConsumer', () => {
  it('recognizes active array and object injections', () => {
    expect(hasCmdlineConsumer([
      { id: 'ordinary', name: 'ordinary' },
      { id: 'disabled-startup', name: 'disabled-startup', inject: ['cmdlineArgs'], disabled: true },
      { id: 'tui-startup', name: 'tui-startup', inject: { cmdlineArgs: { required: true } } },
    ])).toBe(true)
    expect(hasCmdlineConsumer([
      { id: 'ordinary', name: 'ordinary' },
      { id: 'disabled-startup', name: 'disabled-startup', inject: ['cmdlineArgs'], disabled: true },
    ])).toBe(false)
    expect(() => hasCmdlineConsumer([
      { id: 'web-startup', name: 'web-startup', inject: ['cmdlineArgs'] },
      { id: 'tui-startup', name: 'tui-startup', inject: ['cmdlineArgs'] },
    ])).toThrow('multiple active rows inject cmdlineArgs ("web-startup", "tui-startup")')
  })

  it('walks nested groups and ignores consumers disabled by an ancestor', () => {
    expect(hasCmdlineConsumer([{
      id: 'app',
      name: 'cordis:group',
      group: true,
      config: [{ id: 'startup', name: 'startup', inject: ['cmdlineArgs'] }],
    }])).toBe(true)
    expect(hasCmdlineConsumer([{
      id: 'app',
      name: 'cordis:group',
      group: true,
      disabled: true,
      config: [{ id: 'startup', name: 'startup', inject: ['cmdlineArgs'] }],
    }])).toBe(false)
    expect(() => hasCmdlineConsumer([
      {
        id: 'first',
        name: 'cordis:group',
        group: true,
        config: [{ id: 'startup', name: 'startup', inject: ['cmdlineArgs'] }],
      },
      {
        id: 'second',
        name: 'cordis:group',
        group: true,
        config: [{ id: 'startup', name: 'startup', inject: ['cmdlineArgs'] }],
      },
    ])).toThrow('multiple active rows inject cmdlineArgs ("first:startup", "second:startup")')
  })
})

describe('runStartup', () => {
  it('lets a row read the flag value the app resolved', async () => {
    const { observed } = await bootFixture(['--port', '8080'])
    expect(observed.started).toEqual({ port: 8080 })
    expect(observed.exits).toEqual([])
  })

  it('leaves a row on the value written beside the expression when no flag names one', async () => {
    const { observed } = await bootFixture([])
    expect(observed.started).toEqual({ port: 3080 })
  })

  it('recognizes the Loader object form of a startup-service injection', async () => {
    const { observed } = await bootFixture(['--port', '8080'], demoPlan, { objectInject: true })
    expect(observed.started).toEqual({ port: 8080 })
  })

  it('prints the app help, starts no reading row, and requests exit 0', async () => {
    const { observed } = await bootFixture(['--help'])
    expect(observed.out).toContain('Usage: demo')
    expect(observed.started).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects the invocation from the plan without starting the app', async () => {
    const { observed } = await bootFixture(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(observed.started).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rethrows a plan failure that is not commander asking to exit', async () => {
    const { ctx } = await bootFixture([], demoPlan, { withoutStartup: true })
    const plan: StartupPlan = () => { throw new Error('plan exploded') }
    expect(() => { runStartup(ctx, 'demoStartup', demoCommand(), plan) }).toThrow('plan exploded')
  })

  it('rethrows a thrown value that is not an object at all', async () => {
    const { ctx } = await bootFixture([], demoPlan, { withoutStartup: true })
    const plan: StartupPlan = () => {
      const thrown: unknown = 'plan threw a string'
      throw thrown
    }
    expect(() => { runStartup(ctx, 'demoStartup', demoCommand(), plan) }).toThrow('plan threw a string')
  })

  it('fails loud when no row injects the service the app provides', async () => {
    // The bundle patch and its startup row disagree; a silent no-op would leave
    // every row of the app on its fallbacks with no explanation.
    const { ctx } = await bootFixture([], demoPlan, { withoutStartup: true })
    expect(() => { runStartup(ctx, 'absentStartup', demoCommand()) })
      .toThrow('absentStartup: no row injects this startup service')
  })

  it('accepts a service-name list when the app declares no plan', async () => {
    const { ctx } = await bootFixture([], demoPlan, { withoutStartup: true })
    runStartup(ctx, ['demoStartup'], demoCommand())
    expect(ctx.get('demoStartup')).toEqual({})
  })
})

describe('enableRow', () => {
  it('enables the named Loader row and fails loud when the Loader or row is absent', async () => {
    const withoutLoader = new Context()
    await expect(enableRow(withoutLoader, 'client-hmr')).rejects.toThrow('requires the Loader service')

    const ctx = new Context()
    let update: unknown
    ctx.provide('loader', {
      entries: () => [{
        options: { id: 'client-hmr' },
        update: async (options: unknown) => { update = options },
      }],
    } as never)
    await enableRow(ctx, 'client-hmr')
    expect(update).toEqual({ disabled: false })
    await expect(enableRow(ctx, 'absent')).rejects.toThrow('no "absent" row to enable')
  })
})

describe('provideCmdline', () => {
  it('hands the app a snapshot the caller cannot mutate afterwards', () => {
    const ctx = new Context()
    const args = ['--resume', 'abc']
    const ready = Promise.resolve()
    provideCmdline(ctx, { args, exit: () => {}, ready })
    args.push('--tampered')
    expect(ctx.cmdlineArgs?.get()).toEqual(['--resume', 'abc'])
    expect(ctx.appReady).toBe(ready)
  })

  it('fails loud when a startup row runs without the launcher values', () => {
    const ctx = new Context()
    expect(() => { runStartup(ctx, 'demoStartup', demoCommand()) })
      .toThrow('the launcher must provide ctx.cmdlineArgs and ctx.appExit')
  })

  it('resolves nothing when the tree was disposed while the startup row parsed', () => {
    // An early SIGTERM takes the Loader with it; there is nothing left to
    // configure, and the bundle did nothing wrong.
    const exits: number[] = []
    const ctx = new Context()
    provideCmdline(ctx, { args: [], exit: code => void exits.push(code) })
    expect(() => { runStartup(ctx, 'demoStartup', demoCommand()) }).not.toThrow()
    expect(exits).toEqual([])
  })
})
