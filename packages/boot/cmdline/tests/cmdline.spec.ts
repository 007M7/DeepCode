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
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enableRow, internals, parseCmdline, provideCmdline, type CmdlinePlan,
} from '../src/index.ts'

/** Every value one boot of the fixture tree observed. */
interface Observed {
  /** Config the reading row started with; absent means it never started. */
  started?: Record<string, unknown>
  exits: number[]
  out: string
}

/** A booted fixture tree: what it observed, and its root for direct parser calls. */
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
const demoPlan: CmdlinePlan<{ port?: number }> = (program) => {
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
  plan: CmdlinePlan = demoPlan,
  options: { objectInject?: boolean; withoutProvider?: boolean } = {},
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
export function apply(ctx) { return globalThis.__provideDemoArgs(ctx) }
`)
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as { __observed: Observed; __provideDemoArgs: (ctx: Context) => void }
  globals.__observed = observed
  globals.__provideDemoArgs = (ctx: Context) => {
    const values = parseCmdline(ctx, demoCommand(), plan)
    if (values !== undefined) ctx.provide('demoStartup', values)
  }

  // The composition, exactly as a profile delivers one: include patches whose
  // config carries `!!js` expressions.
  const composition: PatchOptions[] = [{
    insert: [
      ...options.withoutProvider === true
        ? []
        : [{ id: 'demo-startup', name: pathToFileURL(join(dir, 'startup.mjs')).href }],
      {
        id: 'reader',
        name: pathToFileURL(join(dir, 'reader.mjs')).href,
        inject: options.objectInject === true ? { demoStartup: { required: true } } : ['demoStartup'],
        config: { port: expression('ctx.demoStartup.port ?? 3080') },
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

describe('parseCmdline', () => {
  it('lets a row read the flag value the app resolved', async () => {
    const { observed } = await bootFixture(['--port', '8080'])
    expect(observed.started).toEqual({ port: 8080 })
    expect(observed.exits).toEqual([])
  })

  it('leaves a row on the value written beside the expression when no flag names one', async () => {
    const { observed } = await bootFixture([])
    expect(observed.started).toEqual({ port: 3080 })
  })

  it('recognizes the Loader object form of a provider-service injection', async () => {
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
    const { ctx } = await bootFixture([], demoPlan, { withoutProvider: true })
    const plan: CmdlinePlan = () => { throw new Error('plan exploded') }
    expect(() => { parseCmdline(ctx, demoCommand(), plan) }).toThrow('plan exploded')
  })

  it('rethrows a thrown value that is not an object at all', async () => {
    const { ctx } = await bootFixture([], demoPlan, { withoutProvider: true })
    const plan: CmdlinePlan = () => {
      const thrown: unknown = 'plan threw a string'
      throw thrown
    }
    expect(() => { parseCmdline(ctx, demoCommand(), plan) }).toThrow('plan threw a string')
  })

  it('returns values without inspecting Loader rows or owning a service', async () => {
    const { ctx } = await bootFixture([], demoPlan, { withoutProvider: true })
    expect(parseCmdline(ctx, demoCommand())).toEqual({})
    expect(ctx.get('demoStartup')).toBeUndefined()
  })
})

describe('enableRow', () => {
  it('enables the named Loader row and fails loud when the Loader or row is absent', async () => {
    const withoutLoader = new Context()
    await expect(enableRow(withoutLoader, 'client-hmr')).rejects.toThrow('requires the Loader service')

    const ctx = new Context()
    let enabled = false
    ctx.provide('loader', {
      entries: () => [{
        options: { id: 'client-hmr' },
        enableRuntime: async () => { enabled = true },
      }],
    } as never)
    await enableRow(ctx, 'client-hmr')
    expect(enabled).toBe(true)
    await expect(enableRow(ctx, 'absent')).rejects.toThrow('no "absent" row to enable')
  })

  it('keeps invocation-only activation through config reapplication', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-enable-'))
    const observed = { starts: 0, stops: 0 }
    ;(globalThis as unknown as { __runtimeEnableObserved: typeof observed }).__runtimeEnableObserved = observed
    writeFileSync(join(dir, 'conditional.mjs'), `
export function apply(ctx) {
  globalThis.__runtimeEnableObserved.starts += 1
  ctx.effect(() => () => { globalThis.__runtimeEnableObserved.stops += 1 })
}
`)
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: conditional',
      `  name: ${pathToFileURL(join(dir, 'conditional.mjs')).href}`,
      '  disabled: true',
      '',
    ].join('\n'))

    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
    })
    await ctx.loader.await()
    const conditional = [...ctx.loader.entries()].find(entry => entry.options.id === 'conditional')
    const include = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:include')
    expect(conditional).toBeDefined()
    expect(include?.fiber).toBeDefined()
    expect(conditional?.options.disabled).toBe(true)
    expect(observed).toEqual({ starts: 0, stops: 0 })

    await enableRow(ctx, 'conditional')
    await ctx.loader.await()
    expect(conditional?.disabled).toBe(false)
    expect(conditional?.options.disabled).toBe(true)
    expect(observed).toEqual({ starts: 1, stops: 0 })

    await include!.fiber!.update(include!.options.config, true)
    await ctx.loader.await()
    expect(conditional?.disabled).toBe(false)
    expect(conditional?.options.disabled).toBe(true)
    expect(observed).toEqual({ starts: 1, stops: 0 })
    disposers.push(async () => { await ctx.fiber.dispose() })
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

  it('fails loud when a parser runs without the launcher values', () => {
    const ctx = new Context()
    expect(() => { parseCmdline(ctx, demoCommand()) })
      .toThrow('the launcher must provide ctx.cmdlineArgs and ctx.appExit')
  })

  it('lets multiple parsers read the same immutable snapshot', () => {
    const ctx = new Context()
    provideCmdline(ctx, { args: ['--port', '8080'], exit: () => {} })
    expect(parseCmdline(ctx, demoCommand(), demoPlan)).toEqual({ port: 8080 })
    expect(parseCmdline(ctx, demoCommand(), demoPlan)).toEqual({ port: 8080 })
    expect(Object.isFrozen(ctx.cmdlineArgs?.get())).toBe(true)
  })
})
