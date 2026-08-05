/**
 * Web runtime glue behavior: dist resolution through the bundle's own seam,
 * the frontend-static child claiming the fallback seat, the web-surface
 * prompt section and bash runtime variables, and URL-line printing with the
 * launcher's LAN snapshot.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { HttpServerService } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, internals } from '../src/index.ts'

let dist: string | undefined

afterEach(() => {
  vi.restoreAllMocks()
  internals.resolveDistIndex = originalResolve
  if (dist !== undefined) rmSync(dist, { recursive: true, force: true })
  dist = undefined
})

const originalResolve = internals.resolveDistIndex

/** Stage a dist fixture and point the bundle's resolver at it. */
function stageDist(): string {
  dist = mkdtempSync(join(tmpdir(), 'dsh-web-app-'))
  mkdirSync(join(dist, 'dist'))
  const index = join(dist, 'dist', 'index.html')
  writeFileSync(index, '<head></head><body>shell</body>')
  internals.resolveDistIndex = () => index
  return index
}

/** A fake httpServer capturing the fallback seat and index taps. */
function fakeHttpServer(): { server: HttpServerService; seat: () => unknown } {
  let fallback: unknown
  const server = {
    port: 4567,
    registerFallback: (handler: unknown) => {
      fallback = handler
      return () => { fallback = undefined }
    },
    applyIndexTaps: (html: string) => html,
  } as unknown as HttpServerService
  return { server, seat: () => fallback }
}

interface BashContribution {
  name: string
  variables: Record<string, { description: string }>
  resolve: () => Record<string, string>
}

describe('web-app runtime glue', () => {
  it('mounts dist serving, prompt section, bash variables, and prints the URL with the LAN snapshot', async () => {
    stageDist()
    const ctx = new Context()
    const { server, seat } = fakeHttpServer()
    ctx.provide('httpServer', server)
    const contributions: BashContribution[] = []
    ctx.provide('bashEnv', {
      register: (contribution: BashContribution) => {
        contributions.push(contribution)
        return () => {}
      },
    } as never)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ mode: 'development', printUrl: true, lanAddresses: ['192.168.1.5'] }))
    await ctx.plugin(SystemPrompt, { persona: '' })
    // Settle the injected registrations.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(seat()).toBeDefined() // frontend-static claimed the fallback
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567 (LAN: http://192.168.1.5:4567)')
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === 'app:web-surface')
    expect(section?.text).toContain('http://127.0.0.1:4567')
    expect(section?.text).toContain('--dev')
    const webRuntime = contributions.find(contribution => contribution.name === 'web-runtime')
    expect(webRuntime?.resolve()).toEqual({ DSH_WEB_URL: 'http://127.0.0.1:4567', DSH_WEB_MODE: 'development' })
    await ctx.fiber.dispose()
  })

  it('stays quiet in production mode with printUrl off and reports the production update contract', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('httpServer', fakeHttpServer().server)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ mode: 'production', printUrl: false, lanAddresses: [] }))
    await ctx.plugin(SystemPrompt, { persona: '' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(entry => entry.name === 'app:web-surface')?.text)
      .toContain('without `--dev`')
    await ctx.fiber.dispose()
  })

  it('prints the loopback-only URL line when no LAN snapshot exists', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('httpServer', fakeHttpServer().server)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ mode: 'production', printUrl: true, lanAddresses: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567')
    await ctx.fiber.dispose()
  })

  it('fails loud when the prompt section resolves against a portless webserver', async () => {
    stageDist()
    const ctx = new Context()
    // A webserver whose bound port is gone (torn down mid-request): the
    // section must throw, never render a URL with an undefined port.
    const { server } = fakeHttpServer()
    Object.defineProperty(server, 'port', { get: () => undefined })
    ctx.provide('httpServer', server)
    apply(ctx, new Config({ mode: 'production', printUrl: false, lanAddresses: [] }))
    await ctx.plugin(SystemPrompt, { persona: '' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow('httpServer service missing')
    await ctx.fiber.dispose()
  })

  it('resolves the real built frontend dist through the package exports', () => {
    // The production resolver (not the test seam): this checkout builds the
    // dist, so the resolved path must be the frontend package's index.html.
    expect(originalResolve()).toMatch(/dist[/\\]index\.html$/)
  })
})
