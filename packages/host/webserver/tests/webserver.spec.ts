/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver row, and every assertion observes the
 * user-visible HTTP surface of the running server (routing precedence, index
 * taps, static-fallback semantics, per-request error containment, teardown).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import HttpServer from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a dist fixture and a cordis.yml with one webserver row, then boot it through the real Loader. */
async function loadComposition(port = 0): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-webserver-loader-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(port)}`,
    `    distIndex: '${distIndex}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status plus a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, body: (await response.text()).slice(0, 80) }
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('serves registered routes, index taps, and the static fallback semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const server = loaded.httpServer
    expect(server).toBeInstanceOf(HttpServer)
    const port = server.port
    expect(port).toBeGreaterThan(0)

    // Routing precedence: exact beats prefix, longest prefix wins, a prefix
    // route answers its own path, and routes own their method handling
    // (POST reaches a registered prefix; 405 is fallback-only semantics).
    server.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end('EXACT') } })
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.register({ kind: 'prefix', path: '/api/deep', handler: (_req, res) => { res.writeHead(200); res.end('DEEP') } })
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })
    expect(await request(port, '/api/anything')).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/deep/leaf')).toMatchObject({ status: 200, body: 'DEEP' })
    expect(await request(port, '/api')).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/anything', { method: 'POST' })).toMatchObject({ status: 200, body: 'API' })

    // Index taps apply in registration order on `/` and on the SPA fallback;
    // the disposer removes the transform.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    expect((await request(port, '/')).body).toContain('__T__')
    expect((await request(port, '/no/such/route')).body).toContain('__T__')
    untap()
    expect((await request(port, '/')).body).not.toContain('__T__')

    // Static fallback semantics: real asset served, traversal 403, non-GET/
    // HEAD without a matching route 405.
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export {}' })
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/nowhere', { method: 'POST' })).status).toBe(405)

    // Per-request error containment: a malformed %-escape answers 400 and the
    // server keeps serving afterwards (no process-level failure path).
    expect((await request(port, '/%zz')).status).toBe(400)
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Duplicate (kind, path) is a misconfiguration and throws; the disposer
    // restores registrability (register/disposer symmetry).
    expect(() => server.register({ kind: 'exact', path: '/probe', handler: () => {} }))
      .toThrow(/duplicate exact route/)
    const disposeOnce = server.register({ kind: 'exact', path: '/once', handler: (_req, res) => { res.writeHead(200); res.end('ONCE') } })
    expect(await request(port, '/once')).toMatchObject({ status: 200, body: 'ONCE' })
    disposeOnce()
    expect((await request(port, '/once')).body).toContain('shell') // back to the SPA fallback
    expect(() => server.register({ kind: 'exact', path: '/once', handler: () => {} })).not.toThrow()

    // Teardown: fiber dispose closes the socket and severs held connections.
    await loaded.fiber.dispose()
    await expect(request(port, '/probe')).rejects.toThrow()
  })

  it('fails the fiber when the port is already taken (fail-loud at activation)', { timeout: 60_000 }, async () => {
    const first = await loadComposition()
    const takenPort = first.httpServer.port
    const firstRoot = root
    root = undefined // keep the first composition's files until the end

    // loader.await() never rejects (allSettled); the bind failure surfaces as
    // a FAILED fiber whose error escapes as a late rejection — the shape the
    // boot's installFailLoud is contracted to catch. Capture it here the same
    // way, and assert it really is the bind error.
    const rejections: unknown[] = []
    const onUnhandled = (err: unknown): void => { rejections.push(err) }
    process.on('unhandledRejection', onUnhandled)
    let second: Context | undefined
    try {
      second = await loadComposition(takenPort)
      const entry = [...second.loader.entries()].find(e => e.options.name === '@deepseek-ai/dsh-host-webserver')
      expect(entry?.fiber?.state).toBe(FiberState.FAILED)
      // The rejection escapes a tick after loader.await() settles; bounded poll.
      for (let i = 0; i < 100 && rejections.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(rejections.map(String).join('\n')).toContain('EADDRINUSE')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await second?.fiber.dispose()
      context = first
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      root = firstRoot
    }
  })
})
