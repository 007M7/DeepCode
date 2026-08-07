/**
 * The web app's entrypoint row over a REAL Loader tree: every flag lands in the
 * `webStartup` service the web rows read, the bind it reports comes from the
 * flag or from what the composition falls back to, `--help` resolves nothing,
 * and a rejected argument exits without resolving anything.
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
import { apply, WEB_STARTUP_SERVICE, type WebStartupValues } from '../src/startup.ts'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => ({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }],
  }),
}))

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
 * Mount the real entrypoint row over a stand-in for the `webserver` row whose
 * composed bind it reads, the way a profile mounts phase one.
 * @param args - the invocation's inner arguments.
 * @param webserverConfig - the composed `webserver` row config, or `null` to omit the row.
 * @returns the resolved service value (absent when the app requested exit) and what the boot observed.
 */
async function bootStartup(
  args: string[],
  webserverConfig: Record<string, unknown> | null = { host: '127.0.0.1', port: 3080 },
): Promise<{ values: WebStartupValues | undefined; observed: Observed; ctx: Context }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply() {}\n')
  // The Loader imports a row through Node's own resolver, which cannot resolve
  // this workspace's sources; the row delegates to the real plugin the test
  // imported through the source-plane path mapping.
  writeFileSync(join(dir, 'entrypoint.mjs'), `
export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__webStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    ...webserverConfig === null ? [] : [
      '- id: webserver',
      `  name: ${rowUrl}`,
      `  inject: [${WEB_STARTUP_SERVICE}]`,
      '  disabled: true',
      '  config:',
      ...Object.entries(webserverConfig).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
    ],
    // A second reader keeps the composition honest when the webserver row is
    // the one under test: the service must still have someone to serve.
    '- id: web-runtime',
    `  name: ${rowUrl}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    '  disabled: true',
    // The reload chain this bundle ships off, which `--dev` turns on.
    '- id: client-hmr',
    `  name: ${rowUrl}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    '  disabled: true',
    '- id: web-startup',
    `  name: ${pathToFileURL(join(dir, 'entrypoint.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  ;(globalThis as unknown as { __webStartupApply: typeof apply }).__webStartupApply = apply

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { values: ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined, observed, ctx }
}


describe('web startup', () => {
  it('resolves each flag into the value its row reads', async () => {
    const { values } = await bootStartup(['--port', '8080', '--workspace-root', '/w'])
    expect(values).toEqual({
      port: 8080,
      workspaceRoot: '/w',
      mode: 'production',
      trustedHosts: [],
      lanAddresses: [],
    })
  })

  it('names no value for a flag the invocation left out, so each row keeps its own', async () => {
    const { values } = await bootStartup([])
    expect(values).toEqual({ mode: 'production', trustedHosts: [], lanAddresses: [] })
    expect(values).not.toHaveProperty('host')
    expect(values).not.toHaveProperty('port')
  })

  it('derives the LAN literals for an all-interfaces bind, and the extras with them', async () => {
    const { values } = await bootStartup(['--host', '0.0.0.0', '--trusted-host', 'lab.internal'])
    expect(values?.trustedHosts).toEqual(['192.168.1.5', 'lab.internal'])
    // Display gets the same single sample the fence was configured with.
    expect(values?.lanAddresses).toEqual(['192.168.1.5'])
  })

  it('reads the composed bind when no flag names one, so a configured 0.0.0.0 still derives them', async () => {
    const { values } = await bootStartup([], { host: '0.0.0.0', port: 3080 })
    expect(values?.lanAddresses).toEqual(['192.168.1.5'])
  })

  it('reports the development mode for --dev, which the web runtime reads', async () => {
    const { values } = await bootStartup(['--dev'])
    // The runtime row is what turns the reload chain on, in the phase whose
    // host rows it needs; this row only reports the mode.
    expect(values?.mode).toBe('development')
  })

  it('prints its own help and resolves nothing', async () => {
    const { values, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile web')
    expect(observed.out).toContain('--trusted-host')
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects a non-numeric port before anything binds', async () => {
    const { values, observed } = await bootStartup(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('fails the boot when the composition lost the row whose bind it reads', async () => {
    // The bundle patch and this entrypoint must agree on the row set; a
    // missing row would otherwise silently drop the flag that targets it.
    await expect(bootStartup([], null))
      .rejects.toThrow('the web composition has no waiting "webserver" row to configure')
  })
})
