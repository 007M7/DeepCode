import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../../../packages/examples/jsonrpc-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const decompress = promisify(zstdDecompress)

function waitForLine(
  lines: string[],
  predicate: (value: Record<string, unknown>) => boolean,
  stderr: () => string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000
    const poll = (): void => {
      while (lines.length > 0) {
        const line = lines.shift()!
        if (!line.trim()) continue
        try {
          const value = JSON.parse(line) as Record<string, unknown>
          if (predicate(value)) {
            resolve(value)
            return
          }
        } catch {
          reject(new Error(`non-JSON stdout from JSON-RPC agent runtime: ${line}`))
          return
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for JSON-RPC response; stderr=${stderr()}`))
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe('jsonrpc-agent keyless smoke', () => {
  it.each([
    { label: 'accepts max-token results by default', envValue: undefined, expectedStatus: 'ok' },
    { label: 'accepts max-token results when enabled through env', envValue: 'true', expectedStatus: 'ok' },
    { label: 'reports max-token results as errors when disabled through env', envValue: 'false', expectedStatus: 'error' },
  ])('$label', async ({ envValue, expectedStatus }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-agent-smoke-'))
    const modelRequests: Record<string, unknown>[] = []
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        modelRequests.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
        response.write('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('model server did not bind a TCP port')
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      binScript,
      configPath,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_CWD: root,
        DSH_SESSION_ROOT: join(root, '.sessions'),
        ...(envValue === undefined ? {} : { DSH_MAX_TOKENS_AS_SUCCESS: envValue }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines: string[] = []
    let stdoutBuffer = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const parts = stdoutBuffer.split('\n')
      stdoutBuffer = parts.pop() ?? ''
      lines.push(...parts)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { cwd: root, provider: 'deepseek', model: 'deepseek-v4-pro' },
      })}\n`)
      const initialized = await waitForLine(lines, value => value.id === 1, () => stderr)
      expect(initialized).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } },
      })

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'inspect tools' }] },
      })}\n`)
      const finished = await waitForLine(lines, value => value.method === 'session.finished', () => stderr)
      expect(finished).toMatchObject({
        jsonrpc: '2.0',
        method: 'session.finished',
        params: {
          sessionId: 'main',
          status: expectedStatus,
          reason: { kind: 'max-tokens' },
        },
      })
      const prompt = await waitForLine(lines, value => value.id === 2, () => stderr)
      expect(prompt).toMatchObject({ jsonrpc: '2.0', id: 2, result: { accepted: true } })
      const tools = modelRequests[0]?.tools as { function?: { name?: string } }[]
      expect(tools.map(tool => tool.function?.name).sort()).toEqual([
        'bash',
        'edit',
        'read',
        'subagent',
        'todo_write',
        'write',
      ])

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`)
      const shutdown = await waitForLine(lines, value => value.id === 3, () => stderr)
      expect(shutdown).toMatchObject({ jsonrpc: '2.0', id: 3, result: {} })
      if (child.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          child.once('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`runtime exited ${code}; stderr=${stderr}`))
          })
        })
      } else {
        expect(child.exitCode, stderr).toBe(0)
      }
      const sessionsRoot = join(root, '.sessions')
      const files = await readdir(sessionsRoot, { recursive: true })
      const log = files.find(file => file.endsWith('.jsonl.zstd'))
      expect(log).toBeDefined()
      const compressed = await readFile(join(sessionsRoot, log!))
      expect(compressed.subarray(0, 4).toString('hex')).toBe('28b52ffd')
      expect(JSON.parse((await decompress(compressed)).toString())).toMatchObject({ type: 'session', id: 'main' })
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)

  it('rejects an invalid max-token success env value', async () => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      binScript,
      configPath,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
        DSH_MAX_TOKENS_AS_SUCCESS: 'sometimes',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })

    expect(exitCode, stderr).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('plugin(s) failed to load: @deepseek-ai/dsh-jsonrpc')
  }, 10_000)
})
