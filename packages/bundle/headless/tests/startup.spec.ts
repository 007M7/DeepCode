/**
 * The one-shot app's startup row over a REAL Loader tree: the task
 * positional reaches the runner row, a missing task is a usage error, and the
 * web startup service this app absorbs releases its rows on the composed values.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import z from 'schemastery'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { WEB_STARTUP_SERVICE } from '@deepseek-ai/dsh-web-app/startup'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, HEADLESS_STARTUP_SERVICE } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  started: Record<string, Record<string, unknown>>
  exits: number[]
  out: string
  /** Patches the startup row handed the launcher for later compositions. */
  contributed: unknown[]
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Boot the real headless startup row over stand-ins for the runner row and one
 * web row it absorbs.
 * @param args - the invocation's inner arguments.
 * @returns what the boot observed.
 */
async function bootStartup(args: string[], options: { withoutRunner?: boolean } = {}): Promise<Observed> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-startup-'))
  const observed: Observed = { started: {}, exits: [], out: '', contributed: [] }
  // The runner's real schema requires the task, which is exactly what makes a
  // waiting-but-enabled row fail at fiber creation; the stand-in keeps that.
  writeFileSync(join(dir, 'row.mjs'), `
export const Config = globalThis.__headlessRunnerConfigSchema
export function apply(ctx, config) { globalThis.__headlessStartupObserved.started[ctx.fiber.entry.options.id] = config ?? {} }
`)
  writeFileSync(join(dir, 'plain-row.mjs'), `
export function apply(ctx, config) { globalThis.__headlessStartupObserved.started[ctx.fiber.entry.options.id] = config ?? {} }
`)
  // The Loader imports a row through Node's own resolver, which cannot resolve
  // this workspace's sources; the row delegates to the real plugin the test
  // imported through the source-plane path mapping.
  writeFileSync(join(dir, 'startup-row.mjs'), `
export const name = 'headless-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__headlessStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  const plainRowUrl = pathToFileURL(join(dir, 'plain-row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    // A composition that lost the runner still injects the startup service, so
    // the startup row reaches its own row check rather than the generic one.
    options.withoutRunner === true ? '- id: displaced-runner' : '- id: headless-runner',
    `  name: ${rowUrl}`,
    `  inject: [${HEADLESS_STARTUP_SERVICE}]`,
    // Shipped off, like the bundle patch: the schema below requires the task,
    // which only the startup row can supply.
    '  disabled: true',
    '- id: webserver',
    `  name: ${plainRowUrl}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    '  config:',
    '    port: 0',
    '- id: headless-startup',
    `  name: ${pathToFileURL(join(dir, 'startup-row.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __headlessStartupObserved: Observed
    __headlessStartupApply: typeof apply
    __headlessRunnerConfigSchema: unknown
  }
  globals.__headlessStartupObserved = observed
  globals.__headlessStartupApply = apply
  globals.__headlessRunnerConfigSchema = z.object({ task: z.string().required() })

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, {
    args,
    exit: code => void observed.exits.push(code),
    contribute: patches => void observed.contributed.push(...patches),
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return observed
}

describe('headless startup', () => {
  it('joins the task positional and starts the runner with it', async () => {
    const observed = await bootStartup(['run', 'the', 'tests'])
    expect(observed.started['headless-runner']).toEqual({ task: 'run the tests' })
    expect(observed.exits).toEqual([])
  })

  it('hands the task to the launcher as a patch, so a recomposition keeps it', async () => {
    const observed = await bootStartup(['run', 'the', 'tests'])
    expect(observed.contributed).toEqual([
      { id: 'headless-runner', disabled: false, config: { task: 'run the tests' } },
    ])
  })

  it('starts the web rows it absorbed on the composed one-shot values', async () => {
    const observed = await bootStartup(['task'])
    expect(observed.started.webserver).toEqual({ port: 0 })
  })

  it('rejects an invocation with no task instead of failing inside the runner schema', async () => {
    const observed = await bootStartup([])
    expect(observed.out).toContain('a task is required')
    expect(observed.started).toEqual({})
    expect(observed.exits).toEqual([1])
  })

  it('fails the boot when the composition has no runner row to give the task to', async () => {
    await expect(bootStartup(['task'], { withoutRunner: true }))
      .rejects.toThrow('the composition has no waiting "headless-runner" row')
  })

  it('prints its own help and starts nothing', async () => {
    const observed = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile headless')
    expect(observed.started).toEqual({})
    expect(observed.exits).toEqual([0])
  })
})
