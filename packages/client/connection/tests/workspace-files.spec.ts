/**
 * Workspace-file reads over a real HTTP server and a real temporary
 * workspace: confinement, content typing, and the sandbox header are wire
 * facts, so they are asserted against responses Node actually produced.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FILES_PATH } from '@deepseek-ai/dsh-host-apiproxy/api'
import { handleWorkspaceFile } from '../src/workspace-files.ts'

const SESSION = 's-1'

let workspace: string
let outside: string
let origin: string
let close: () => Promise<void>

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  workspace = join(root, 'workspace')
  outside = join(root, 'outside')
  await mkdir(join(workspace, 'out'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'index.html'), '<h1>产物</h1>')
  await writeFile(join(workspace, 'notes.txt'), 'plain')
  await writeFile(join(workspace, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(workspace, 'model.safetensors'), 'unknown extension')
  await writeFile(join(workspace, 'out', 'page.html'), '<p>nested</p>')
  await writeFile(join(outside, 'secret.html'), 'SECRET')
  await symlink(join(outside, 'secret.html'), join(workspace, 'escape.html'))

  const server = createServer((req, res) => {
    void handleWorkspaceFile(req, res, {
      // 'rooted' names the filesystem root, the separator-terminated realpath case.
      cwdFor: async sessionId => sessionId === SESSION ? workspace : sessionId === 'rooted' ? sep : undefined,
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || error === null) resolve()
      else reject(error)
    })
  })
  return async () => { await rm(root, { recursive: true, force: true }) }
})

afterAll(async () => { await close() })

function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, init)
}

describe('workspace file reads', () => {
  it('serves an active document into an opaque origin', async () => {
    const response = await get(`${FILES_PATH}/${SESSION}/index.html`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<h1>产物</h1>')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    // A workspace file is not necessarily agent-authored, and same-origin
    // script here would pass the browser-trust fence into every RPC method.
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toBe('inline')
  })

  it('sandboxes SVG too, and leaves inert types unrestricted', async () => {
    const svg = await get(`${FILES_PATH}/${SESSION}/chart.svg`)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toContain('sandbox')
    const text = await get(`${FILES_PATH}/${SESSION}/notes.txt`)
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(text.headers.get('content-security-policy')).toBeNull()
  })

  it('serves a workspace rooted at a filesystem root, whose realpath already ends in a separator', async () => {
    // `realpath('/')` is '/', so a naive `root + sep` prefix is '//' and every
    // child of that workspace would 403.
    const rooted = await fetch(`${origin}${FILES_PATH}/rooted${new URL(`file://${workspace}/notes.txt`).pathname}`)
    expect(rooted.status).toBe(200)
    expect(await rooted.text()).toBe('plain')
  })

  it('shows an unknown extension as text rather than downloading it', async () => {
    const response = await get(`${FILES_PATH}/${SESSION}/model.safetensors`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('serves a nested path, so a document reaches its own siblings', async () => {
    const response = await get(`${FILES_PATH}/${SESSION}/out/page.html`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<p>nested</p>')
  })

  it('answers HEAD with the length and no body', async () => {
    const response = await get(`${FILES_PATH}/${SESSION}/notes.txt`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('5')
    expect(await response.text()).toBe('')
  })

  it('refuses a symlink whose target leaves the workspace', async () => {
    const response = await get(`${FILES_PATH}/${SESSION}/escape.html`)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('SECRET')
  })

  it('reports missing files, directories, and unknown sessions as absent', async () => {
    expect((await get(`${FILES_PATH}/${SESSION}/nope.html`)).status).toBe(404)
    expect((await get(`${FILES_PATH}/${SESSION}/out`)).status).toBe(404)
    // A path whose ancestor is a file, not a directory.
    expect((await get(`${FILES_PATH}/${SESSION}/notes.txt/child`)).status).toBe(404)
    expect((await get(`${FILES_PATH}/s-other/index.html`)).status).toBe(404)
    expect((await get(`${FILES_PATH}/${SESSION}`)).status).toBe(404)
  })
})

describe('workspace file streaming failures', () => {
  it('tears the response down instead of rejecting when the body cannot be written', async () => {
    // A client that goes away mid-stream must not surface as a handler
    // rejection: the webserver's last-resort guard would log it and try to
    // answer 400 on a response whose status line is already out.
    const sink = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error('socket gone')) },
    })
    const response = Object.assign(sink, { writeHead: () => response }) as unknown as ServerResponse
    await expect(handleWorkspaceFile(
      { url: `${FILES_PATH}/${SESSION}/index.html`, method: 'GET', headers: {} } as never,
      response,
      { cwdFor: async () => workspace },
    )).resolves.toBeUndefined()
    expect(sink.destroyed).toBe(true)
  })
})
