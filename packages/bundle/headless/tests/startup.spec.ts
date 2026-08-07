/**
 * The one-shot app's entrypoint row over a REAL Loader tree: the task
 * positional becomes the value the runner row reads, a missing task is a usage
 * error, and the web service this app absorbs is provided too, so the web rows
 * it rides over resolve on their own fallbacks.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { WEB_STARTUP_SERVICE } from '@deepseek-ai/dsh-web-app/startup'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, HEADLESS_STARTUP_SERVICE, type HeadlessStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real entrypoint row over stand-ins for the runner row and one web
 * row this app absorbs, the way a profile mounts phase one.
 * @param args - the invocation's inner arguments.
 * @param options - fixture knobs for the shapes a composition can take.
 * @returns the resolved service values (absent when the app requested exit) and what the boot observed.
 */
async function bootStartup(
  args: string[],
  options: { withoutRunner?: boolean } = {},
): Promise<{ task: HeadlessStartupValues | undefined; web: unknown; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply() {}\n')
  // The Loader imports a row through Node's own resolver, which cannot resolve
  // this workspace's sources; the row delegates to the real plugin the test
  // imported through the source-plane path mapping.
  writeFileSync(join(dir, 'entrypoint.mjs'), `
export const name = 'headless-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__headlessStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    // A composition that lost the runner still injects the service, so the
    // entrypoint reaches its own row check rather than the generic one.
    options.withoutRunner === true ? '- id: displaced-runner' : '- id: headless-runner',
    `  name: ${rowUrl}`,
    `  inject: [${HEADLESS_STARTUP_SERVICE}]`,
    '  disabled: true',
    '- id: webserver',
    `  name: ${rowUrl}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    '  disabled: true',
    '- id: headless-startup',
    `  name: ${pathToFileURL(join(dir, 'entrypoint.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  ;(globalThis as unknown as { __headlessStartupApply: typeof apply }).__headlessStartupApply = apply

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    task: ctx.get(HEADLESS_STARTUP_SERVICE) as HeadlessStartupValues | undefined,
    web: ctx.get(WEB_STARTUP_SERVICE),
    observed,
  }
}

describe('headless startup', () => {
  it('joins the task positional into the value the runner reads', async () => {
    const { task, observed } = await bootStartup(['run', 'the', 'tests'])
    expect(task).toEqual({ task: 'run the tests' })
    expect(observed.exits).toEqual([])
  })

  it('provides the web service it absorbed, so those rows resolve on their own fallbacks', async () => {
    const { web } = await bootStartup(['task'])
    expect(web).toEqual({ task: 'task' })
  })

  it('rejects an invocation with no task instead of failing inside the runner schema', async () => {
    const { task, observed } = await bootStartup([])
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('prints its own help and resolves nothing', async () => {
    const { task, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile headless')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('fails the boot when the composition has no runner row to give the task to', async () => {
    await expect(bootStartup(['task'], { withoutRunner: true }))
      .rejects.toThrow('the composition has no waiting "headless-runner" row')
  })
})
