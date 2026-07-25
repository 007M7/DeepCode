import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWebServer, type RunningWebServer } from '../src/index.ts'

/** dist fixture: index.html + one asset of each MIME class + a subdir. */
function makeDist(): { distIndex: string; distRoot: string } {
  const distRoot = mkdtempSync(join(tmpdir(), 'dsh-webserver-'))
  writeFileSync(join(distRoot, 'index.html'), '<html>INDEX</html>')
  writeFileSync(join(distRoot, 'app.js'), 'console.log(1)')
  writeFileSync(join(distRoot, 'app.css'), 'body{}')
  writeFileSync(join(distRoot, 'logo.svg'), '<svg/>')
  writeFileSync(join(distRoot, 'data.json'), '{}')
  writeFileSync(join(distRoot, 'app.js.map'), '{}')
  writeFileSync(join(distRoot, 'blob.bin'), 'BIN')
  mkdirSync(join(distRoot, 'sub'))
  writeFileSync(join(distRoot, 'sub', 'page.html'), '<html>SUB</html>')
  return { distIndex: join(distRoot, 'index.html'), distRoot }
}

const echoingApi = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init)
    if (req.url.endsWith('/api/echo')) {
      return Response.json({ method: req.method, body: await req.text(), header: req.headers.get('x-probe') })
    }
    if (req.url.endsWith('/api/empty')) return new Response(null, { status: 204 })
    if (req.url.endsWith('/api/big')) {
      // Chunks far above any socket highWaterMark force res.write to return false.
      const big = new Uint8Array(4 * 1024 * 1024).fill(65)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(big)
          controller.enqueue(big)
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } })
    }
    if (req.url.endsWith('/api/sse')) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: one\n\n'))
          controller.enqueue(encoder.encode('data: two\n\n'))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (req.url.endsWith('/api/throw-string')) {
      // Non-Error rejection: the guard must wrap it for onError.
      throw 'string failure'
    }
    if (req.url.endsWith('/api/explode-mid-stream')) {
      // Headers go out with the first chunk, then the source errors: the
      // guard's headersSent leg must destroy the socket, not writeHead again.
      // The error is deferred a tick so the 200 + first chunk actually flush
      // to the client before the teardown.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'))
          setTimeout(() => { controller.error(new Error('stream exploded')) }, 20)
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (req.url.endsWith('/api/abort-probe')) {
      // Endless SSE that only ends when the request signal aborts.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          req.signal.addEventListener('abort', () => {
            try {
              controller.close()
            } catch { /* already closed by teardown: nothing else can reach this */ }
          }, { once: true })
          controller.enqueue(new TextEncoder().encode('data: open\n\n'))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('nope', { status: 404 })
  },
}

let server: RunningWebServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function boot(onError: (err: Error) => void = () => undefined): Promise<string> {
  const { distIndex } = makeDist()
  server = await startWebServer({ host: '127.0.0.1', port: 0, distIndex, apiHandler: echoingApi }, onError)
  return `http://127.0.0.1:${String(server.port)}`
}

describe('startWebServer', () => {
  it('reports the listening port and closes idempotently', async () => {
    const { distIndex } = makeDist()
    server = await startWebServer({ host: '127.0.0.1', port: 0, distIndex, apiHandler: echoingApi }, () => undefined)
    expect(server.port).toBeGreaterThan(0)
    const first = server.close()
    const second = server.close()
    expect(second).toBe(first)
    await first
    server = undefined
  })

  it.each(['127.0.0.1', '0.0.0.0'])('forwards bind address %s without opening a socket', async (host) => {
    const { distIndex } = makeDist()
    const port = 3080
    const listen = vi.spyOn(NetServer.prototype, 'listen').mockImplementation(function (
      this: NetServer, ...args: unknown[]
    ): NetServer {
      const callback = args.at(-1)
      if (typeof callback !== 'function') throw new TypeError('listen callback missing')
      queueMicrotask(callback as () => void)
      return this
    })
    const address = vi.spyOn(NetServer.prototype, 'address').mockReturnValue({ address: host, family: 'IPv4', port })
    try {
      const inertServer = await startWebServer({ host, port, distIndex, apiHandler: echoingApi }, () => undefined)
      expect(listen).toHaveBeenCalledWith(port, host, expect.any(Function))
      await inertServer.close()
    } finally {
      address.mockRestore()
      listen.mockRestore()
    }
  })

  it('rejects when the port is already taken', async () => {
    const { distIndex } = makeDist()
    server = await startWebServer({ host: '127.0.0.1', port: 0, distIndex, apiHandler: echoingApi }, () => undefined)
    const { port } = server
    await expect(startWebServer({ host: '127.0.0.1', port, distIndex, apiHandler: echoingApi }, () => undefined))
      .rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})

describe.skipIf(process.platform === 'win32')('static serving', () => {
  it('serves index at /, subpaths by MIME, octet-stream for unknown, SPA fallback on miss', async () => {
    const base = await boot()
    const index = await fetch(`${base}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await index.text()).toBe('<html>INDEX</html>')

    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect((await fetch(`${base}/app.css`)).headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect((await fetch(`${base}/logo.svg`)).headers.get('content-type')).toBe('image/svg+xml')
    expect((await fetch(`${base}/data.json`)).headers.get('content-type')).toBe('application/json')
    expect((await fetch(`${base}/app.js.map`)).headers.get('content-type')).toBe('application/json')
    expect((await fetch(`${base}/blob.bin`)).headers.get('content-type')).toBe('application/octet-stream')
    expect(await (await fetch(`${base}/sub/page.html`)).text()).toBe('<html>SUB</html>')

    const miss = await fetch(`${base}/routes/deep/link`)
    expect(miss.status).toBe(200)
    expect(await miss.text()).toBe('<html>INDEX</html>')
  })

  it('403s traversal outside the dist root and 405s non-GET/HEAD', async () => {
    const base = await boot()
    // %2e%2e would be dot-collapsed by WHATWG URL parsing on both ends; an
    // encoded slash keeps the segment intact until the server's decodeURIComponent.
    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`)
    expect(traversal.status).toBe(403)
    const put = await fetch(`${base}/index.html`, { method: 'PUT', body: 'x' })
    expect(put.status).toBe(405)
  })

  it('answers HEAD like GET (no 405)', async () => {
    const base = await boot()
    const head = await fetch(`${base}/`, { method: 'HEAD' })
    expect(head.status).toBe(200)
  })
})

describe.skipIf(process.platform === 'win32')('web plugin surfaces (boot injection + bundle endpoint + events channel)', () => {
  const FETCH_ID = '@deepseek-ai/dsh-client-ui-layout'
  const graphValue = {
    rev: 'graphrev00001',
    entries: [
      { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=eeee2222ffff', rev: 'eeee2222ffff', immediately: true },
      { id: FETCH_ID, url: `/plugins/${FETCH_ID}/client.js?rev=aaaa0000bbbb`, rev: 'aaaa0000bbbb', inject: [] },
    ],
  }

  /** Captures the server's onRebuilt subscription so tests can fire registry notifications by hand. */
  interface RebuiltHarness {
    notify: (id: string, rev: string) => void
    unsubscribed: boolean
  }

  async function bootWithPlugins(harness?: RebuiltHarness): Promise<string> {
    const { distIndex, distRoot } = makeDist()
    writeFileSync(join(distRoot, 'bundle.js'), 'window.DSHClientProxy.loadPlugin({})')
    const webPlugins = {
      graph: () => graphValue,
      clientPath: (id: string) => id === FETCH_ID ? join(distRoot, 'bundle.js') : undefined,
      onRebuilt: (listener: (id: string, rev: string) => void) => {
        if (harness !== undefined) harness.notify = listener
        return () => {
          if (harness !== undefined) harness.unsubscribed = true
        }
      },
    }
    server = await startWebServer(
      { host: '127.0.0.1', port: 0, distIndex, apiHandler: echoingApi, webPlugins }, () => undefined,
    )
    return `http://127.0.0.1:${String(server.port)}`
  }

  it('injects the window.__DSH_BOOT__ graph into / and SPA fallbacks; asset requests stay verbatim', async () => {
    const base = await bootWithPlugins()
    const index = await (await fetch(`${base}/`)).text()
    expect(index).toContain('window.__DSH_BOOT__')
    const manifest = /window\.__DSH_BOOT__ = (.*?)<\/script>/.exec(index)?.[1]
    expect(JSON.parse(manifest ?? '')).toEqual(graphValue)

    const fallback = await (await fetch(`${base}/routes/deep/link`)).text()
    expect(fallback).toContain('window.__DSH_BOOT__')
    const direct = await (await fetch(`${base}/index.html`)).text()
    expect(direct).toContain('window.__DSH_BOOT__')

    expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)')
  })

  it('serves registered client bundles with no-cache (rev query ignored) and 404s unknown ids (no SPA fallback)', async () => {
    const base = await bootWithPlugins()
    const bundle = await fetch(`${base}/plugins/${FETCH_ID}/client.js?rev=whatever`)
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(bundle.headers.get('cache-control')).toBe('no-cache')
    expect(await bundle.text()).toContain('DSHClientProxy')

    expect((await fetch(`${base}/plugins/unknown/client.js`)).status).toBe(404)
  })

  it('404s a registered id whose bundle file is unreadable (unbuilt dist must fail loud, not fall back to HTML)', async () => {
    const { distIndex } = makeDist()
    const webPlugins = {
      graph: () => graphValue,
      clientPath: () => '/nonexistent/lib/client.js',
      onRebuilt: () => () => undefined,
    }
    server = await startWebServer(
      { host: '127.0.0.1', port: 0, distIndex, apiHandler: echoingApi, webPlugins }, () => undefined,
    )
    const res = await fetch(`http://127.0.0.1:${String(server.port)}/plugins/${FETCH_ID}/client.js`)
    expect(res.status).toBe(404)
  })

  it('keeps all plugin surfaces off without the webPlugins option', async () => {
    const base = await boot()
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>INDEX</html>')
    // No plugin routes: fall through to static SPA fallback semantics.
    const res = await fetch(`${base}/plugins/x/client.js`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>INDEX</html>')
    const events = await fetch(`${base}/plugins/events`)
    expect(await events.text()).toBe('<html>INDEX</html>')
  })

  it('GET /plugins/events opens SSE with the current graph frame; a registry rebuild notification broadcasts', async () => {
    const harness: RebuiltHarness = { notify: () => { throw new Error('onRebuilt never subscribed') }, unsubscribed: false }
    const base = await bootWithPlugins(harness)
    const events = await fetch(`${base}/plugins/events`)
    expect(events.status).toBe(200)
    expect(events.headers.get('content-type')).toBe('text/event-stream')
    const reader = events.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    async function readUntil(marker: string): Promise<void> {
      while (!buffer.includes(marker)) {
        const chunk = await reader?.read()
        if (chunk?.done !== false) throw new Error('SSE stream ended early')
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    }
    await readUntil('"type":"graph"')
    expect(buffer).toContain(': connected')
    const graphLine = /data: (.*)\n\n/.exec(buffer)?.[1]
    expect(JSON.parse(graphLine ?? '')).toEqual({ type: 'graph', graph: graphValue })

    // The registry's bundle watch observed a rebuild: the server relays it as an SSE frame.
    harness.notify(FETCH_ID, 'cccc1111dddd')
    await readUntil('"type":"rebuilt"')
    expect(buffer).toContain(JSON.stringify({ type: 'rebuilt', id: FETCH_ID, rev: 'cccc1111dddd' }))
    await reader?.cancel()

    // Shutdown unsubscribes the relay (no broadcast into a closed channel).
    await server?.close()
    server = undefined
    expect(harness.unsubscribed).toBe(true)
  })
})

describe('request-handling guard (one bad request must not kill the process)', () => {
  it('400s malformed %-escapes, reports to onError, and stays alive', async () => {
    const errors: Error[] = []
    const base = await boot(err => errors.push(err))
    for (const path of ['/%', '/%c0', '/%zz%']) {
      expect((await fetch(`${base}${path}`)).status).toBe(400)
    }
    expect(errors.length).toBe(3)
    expect(errors[0]?.name).toBe('URIError')
    // The barrage left the server serving.
    expect((await fetch(`${base}/`)).status).toBe(200)
  })

  it('wraps a non-Error throw for onError and still answers 400', async () => {
    const errors: Error[] = []
    const base = await boot(err => errors.push(err))
    expect((await fetch(`${base}/api/throw-string`, { method: 'POST' })).status).toBe(400)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[0]?.message).toBe('string failure')
  })

  it('destroys the socket when the failure lands after headers went out', async () => {
    const errors: Error[] = []
    const base = await boot(err => errors.push(err))
    const response = await fetch(`${base}/api/explode-mid-stream`)
    expect(response.status).toBe(200) // headers made it out before the explosion
    await expect(response.text()).rejects.toThrow() // then the socket is torn down
    expect(errors.length).toBe(1)
    expect((await fetch(`${base}/`)).status).toBe(200)
  })
})

describe('/api bridge', () => {
  it('forwards method, headers, and body; relays status and body back', async () => {
    const base = await boot()
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-probe': 'p1' },
      body: JSON.stringify({ n: 1 }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ method: 'POST', body: '{"n":1}', header: 'p1' })
  })

  it('relays a bodyless response', async () => {
    const base = await boot()
    const response = await fetch(`${base}/api/empty`, { method: 'POST' })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('streams SSE frames through chunk by chunk', async () => {
    const base = await boot()
    const response = await fetch(`${base}/api/sse`)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
  })

  it('waits for drain when a streamed chunk overfills the socket buffer', async () => {
    // 4 MiB chunks dwarf the socket highWaterMark, so res.write returns false
    // and the bridge parks on 'drain'; reading the body to completion proves
    // the loop resumed instead of dropping the remainder.
    const base = await boot()
    const response = await fetch(`${base}/api/big`)
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.length).toBe(8 * 1024 * 1024)
    expect(body[0]).toBe(65)
    expect(body[body.length - 1]).toBe(65)
  })

  it('releases a drain wait when the client disconnects mid-chunk', async () => {
    // The 'close' leg of the drain race: abort while the socket buffer is
    // still full so the parked write wakes via 'close', not 'drain'.
    const base = await boot()
    const ac = new AbortController()
    const response = await fetch(`${base}/api/big`, { signal: ac.signal })
    const reader = response.body?.getReader()
    const first = await reader?.read()
    expect(first?.value?.length).toBeGreaterThan(0)
    ac.abort()
    // afterEach close() completing is the leak assertion, same as abort-probe.
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  })

  it('aborts the bridged request when the client disconnects mid-SSE', async () => {
    const base = await boot()
    const ac = new AbortController()
    const response = await fetch(`${base}/api/abort-probe`, { signal: ac.signal })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value)).toContain('open')
    ac.abort()
    // server-side abort propagation has no client-observable handshake beyond
    // the closed connection; close() would hang on a leaked live SSE socket,
    // so afterEach completing IS the assertion that the bridge released it.
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  })
})
