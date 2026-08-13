/**
 * The interactive app's command-line provider over a real Loader tree: a
 * no-positional invocation publishes cwd, while help and grammar errors leave
 * the runner pending.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, CLI_STARTUP_SERVICE, type CliStartupValues } from '../src/startup.ts'

/** Effects observed from one fixture boot. */
interface Observed {
  exits: number[]
  out: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real startup provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the startup service and runner/process effects.
 */
async function bootStartup(args: string[]): Promise<{
  startup: CliStartupValues | undefined
  observed: Observed
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__cliStartupObserved.runnerConfig = config }\n')
  writeFileSync(join(dir, 'startup.mjs'), [
    "export const name = 'cli-startup'",
    "export const inject = ['cmdlineArgs']",
    'export const apply = ctx => globalThis.__cliStartupApply(ctx)',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: cli-runner',
    `  name: ${pathToFileURL(join(dir, 'row.mjs')).href}`,
    `  inject: [${CLI_STARTUP_SERVICE}]`,
    '  config:',
    '    cwd: !!js ctx.cliStartup.cwd',
    '- id: cli-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __cliStartupApply: typeof apply
    __cliStartupObserved: Observed
  }
  globals.__cliStartupApply = apply
  globals.__cliStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    startup: ctx.get(CLI_STARTUP_SERVICE) as CliStartupValues | undefined,
    observed,
  }
}

describe('cli command-line provider', () => {
  it('publishes the invoking directory and activates the runner', async () => {
    const { startup, observed } = await bootStartup([])
    expect(startup).toEqual({ cwd: process.cwd() })
    expect(observed.runnerConfig).toEqual({ cwd: process.cwd() })
    expect(observed.exits).toEqual([])
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { startup, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('Usage: deepseek')
    expect(startup).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects positional input and leaves the runner pending', async () => {
    const { startup, observed } = await bootStartup(['unexpected'])
    expect(observed.out).toContain('too many arguments')
    expect(startup).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })
})
