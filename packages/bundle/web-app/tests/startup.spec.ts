/**
 * The web app's startup row over a REAL Loader tree carrying this bundle's
 * waiting row ids: flags reach the rows they configure, absent flags leave the
 * composed values standing, `--dev` enables the shipped-disabled HMR receiver,
 * and `--help` leaves the app unstarted.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, WEB_STARTUP_SERVICE } from '../src/startup.ts'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => ({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }],
  }),
}))

/** What one boot of the fixture tree observed. */
interface Observed {
  /** Config each waiting row started with, by row id; absent means it never started. */
  started: Record<string, Record<string, unknown>>
  exits: number[]
  out: string
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/** One stand-in for a row this bundle's patch makes wait for the web startup. */
interface WaitingRow {
  id: string
  config?: Record<string, unknown>
  disabled?: boolean
}

/** The waiting rows this bundle's patch declares, with the composed values they ship. */
const WAITING_ROWS: WaitingRow[] = [
  { id: 'webserver', config: { host: '127.0.0.1', port: 3080 } },
  { id: 'api-gateway', config: { provider: 'deepseek-official' } },
  { id: 'connection', config: { trustedHosts: ['configured.internal'] } },
  { id: 'web-runtime', config: { mode: 'production', printUrl: true } },
  { id: 'client-hmr', disabled: true },
]

/**
 * Boot the real startup row over stand-ins for this bundle's waiting rows.
 * @param args - the invocation's inner arguments.
 * @returns what the boot observed.
 */
async function bootStartup(args: string[], rows: readonly WaitingRow[] = WAITING_ROWS): Promise<Observed> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-startup-'))
  const observed: Observed = { started: {}, exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), `
export function apply(ctx, config) { globalThis.__webStartupObserved.started[ctx.fiber.entry.options.id] = config ?? {} }
`)
  // The Loader imports a row through Node's own resolver, which cannot resolve
  // this workspace's sources; the row delegates to the real plugin the test
  // imported through the source-plane path mapping.
  writeFileSync(join(dir, 'startup-row.mjs'), `
export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__webStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  const lines = rows.flatMap(row => [
    `- id: ${row.id}`,
    `  name: ${rowUrl}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    ...row.disabled === true ? ['  disabled: true'] : [],
    ...row.config === undefined ? [] : ['  config:', ...Object.entries(row.config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)],
  ])
  lines.push('- id: web-startup', `  name: ${pathToFileURL(join(dir, 'startup-row.mjs')).href}`)
  writeFileSync(join(dir, 'cordis.yml'), lines.join('\n') + '\n')
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as { __webStartupObserved: Observed; __webStartupApply: typeof apply }
  globals.__webStartupObserved = observed
  globals.__webStartupApply = apply

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return observed
}

describe('web startup', () => {
  it('applies each flag to the row that owns it and leaves the rest composed', async () => {
    const observed = await bootStartup(['--port', '8080', '--workspace-root', '/w'])
    expect(observed.started.webserver).toEqual({ host: '127.0.0.1', port: 8080 })
    expect(observed.started['api-gateway']).toEqual({ provider: 'deepseek-official', workspaceRoot: '/w' })
    expect(observed.started['web-runtime']).toEqual({ mode: 'production', printUrl: true, lanAddresses: [] })
    expect(observed.started['client-hmr']).toBeUndefined()
    expect(observed.exits).toEqual([])
  })

  it('starts every row on its composed values when the invocation carries no flags', async () => {
    const observed = await bootStartup([])
    expect(observed.started.webserver).toEqual({ host: '127.0.0.1', port: 3080 })
    expect(observed.started.connection).toEqual({ trustedHosts: ['configured.internal'] })
  })

  it('adds the LAN literals over the configured fence authorities for an all-interfaces bind', async () => {
    const observed = await bootStartup(['--host', '0.0.0.0', '--trusted-host', 'lab.internal'])
    expect(observed.started.webserver).toEqual({ host: '0.0.0.0', port: 3080 })
    expect(observed.started.connection).toEqual({ trustedHosts: ['configured.internal', '192.168.1.5', 'lab.internal'] })
    // Display gets the same single sample the fence was configured with.
    expect(observed.started['web-runtime']).toEqual({ mode: 'production', printUrl: true, lanAddresses: ['192.168.1.5'] })
  })

  it('enables the shipped-disabled HMR receiver for --dev', async () => {
    const observed = await bootStartup(['--dev'])
    expect(observed.started['client-hmr']).toEqual({})
    expect(observed.started['web-runtime']).toEqual({ mode: 'development', printUrl: true, lanAddresses: [] })
  })

  it('prints its own help and starts nothing', async () => {
    const observed = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile web')
    expect(observed.out).toContain('--trusted-host')
    expect(observed.started).toEqual({})
    expect(observed.exits).toEqual([0])
  })

  it('fails the boot when the composition lost a row this app configures', async () => {
    // The bundle patch and this startup plugin must agree on the row set; a
    // missing row would otherwise silently drop the flag that targets it.
    const withoutWebserver = WAITING_ROWS.filter(row => row.id !== 'webserver')
    await expect(bootStartup([], withoutWebserver))
      .rejects.toThrow('the web composition has no waiting "webserver" row')
  })

  it('derives the fence authorities alone when the composition configured none', async () => {
    const withoutTrust = WAITING_ROWS.map(row => row.id === 'connection' ? { id: 'connection' } : row)
    const observed = await bootStartup(['--host', '0.0.0.0'], withoutTrust)
    expect(observed.started.connection).toEqual({ trustedHosts: ['192.168.1.5'] })
  })

  it('rejects a non-numeric port before anything binds', async () => {
    const observed = await bootStartup(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(observed.started).toEqual({})
    expect(observed.exits).toEqual([1])
  })
})
