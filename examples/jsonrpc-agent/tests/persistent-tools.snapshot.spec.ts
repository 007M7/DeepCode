import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const configPath = fileURLToPath(new URL('../persistent-tools.cordis.yml', import.meta.url))
const runtimeBin = fileURLToPath(new URL('../../../packages/examples/jsonrpc-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const expectedPath = fileURLToPath(new URL('./snapshots/persistent-tools/behavior.expected.json', import.meta.url))

interface ModelRequest {
  messages?: Array<Record<string, unknown>>
  tools?: Array<{ function?: { name?: string; parameters?: { required?: string[] } } }>
}

function sseToolCall(id: string, name: string, args: Record<string, unknown>): string[] {
  return [
    'data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n',
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
    })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ]
}

function sseText(text: string): string[] {
  return [
    'data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n',
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ]
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const text = (block as { text?: unknown }).text
    return typeof text === 'string' ? [text] : []
  }).join('')
}

function latestToolCall(messages: Array<Record<string, unknown>>): { id: string; name: string } {
  for (const message of messages.toReversed()) {
    const calls = message.tool_calls
    if (!Array.isArray(calls)) continue
    const call = (calls as unknown[]).at(-1)
    if (typeof call !== 'object' || call === null) continue
    const id = (call as { id?: unknown }).id
    const fn = (call as { function?: { name?: unknown } }).function
    if (typeof id === 'string' && typeof fn?.name === 'string') return { id, name: fn.name }
  }
  throw new Error('model request has no preceding tool call')
}

function normalize(value: string, cwd: string): string {
  return value.replaceAll(cwd, '{{cwd}}')
}

describe('jsonrpc persistent tools snapshot', () => {
  it('runs persistent shell state and editor mutations keylessly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-persistent-tools-'))
    const sessionRoot = join(cwd, '.sessions')
    const target = join(cwd, 'note.txt')
    const requests: ModelRequest[] = []
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as ModelRequest
        requests.push(parsed)
        const messages = parsed.messages ?? []
        const latest = messages.at(-1)
        if (latest === undefined) throw new Error('model request has no messages')
        let chunks: string[]
        if (latest.role !== 'tool') {
          chunks = sseToolCall('bash-1', 'bash', {
            command: 'cd /tmp && export DSH_EXAMPLE_COUNT=1 && printf "COUNT=%s CWD=%s\\n" "$DSH_EXAMPLE_COUNT" "$PWD"',
          })
        } else {
          const call = latestToolCall(messages)
          const toolText = messageText(latest.content)
          if (call.id === 'bash-1') {
            expect(toolText).toContain('COUNT=1 CWD=/tmp')
            chunks = sseToolCall('bash-2', 'bash', {
              command: 'DSH_EXAMPLE_COUNT=$((DSH_EXAMPLE_COUNT + 1)); printf "COUNT=%s CWD=%s\\n" "$DSH_EXAMPLE_COUNT" "$PWD"',
            })
          } else if (call.id === 'bash-2') {
            expect(toolText).toContain('COUNT=2 CWD=/tmp')
            chunks = sseToolCall('editor-create', 'str_replace_editor', {
              command: 'create',
              path: target,
              file_text: 'alpha\n',
            })
          } else if (call.id === 'editor-create') {
            expect(toolText).toContain('New file created successfully')
            chunks = sseToolCall('editor-replace', 'str_replace_editor', {
              command: 'str_replace',
              path: target,
              old_str: 'alpha',
              new_str: 'beta',
            })
          } else if (call.id === 'editor-replace') {
            expect(toolText).toContain('has been edited successfully')
            chunks = sseText('PERSISTENT_TOOLS_OK')
          } else {
            throw new Error(`unexpected tool call ${call.id}`)
          }
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const chunk of chunks) response.write(chunk)
        response.end()
      })
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('model server did not bind')
    const launch = resolveExampleLaunch({
      srcBin: runtimeBin,
      configArgs: [],
      tsconfigPath: repoTsconfig,
    })
    const harness = new DeepSeekHarness({
      launch: {
        command: launch.command,
        args: launch.args,
        cwd: repoRoot,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
          ...Object.fromEntries(Object.entries(launch.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
          DSH_CORDIS_CONFIG: configPath,
          DSH_CWD: cwd,
          DSH_SESSION_ROOT: sessionRoot,
          DEEPSEEK_API_KEY: 'keyless-local-mock',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
        },
        requestTimeoutMs: 60_000,
      },
      cwd,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })

    try {
      const result = await harness.run(
        'Prove that bash state persists, then create and edit note.txt.',
        { sessionId: 'persistent-tools-snapshot' },
      )
      const calls = result.events.flatMap((event) => {
        if (event.type !== 'tool/call') return []
        return [{
          name: event.data.name,
          arguments: normalize(event.data.arguments, cwd),
        }]
      })
      const results = result.events.flatMap((event) => {
        if (event.type !== 'tool/result') return []
        return event.data.message.content.flatMap((block) => {
          if (block.type !== 'tool-result') return []
          return block.content.flatMap(content =>
            content.type === 'text'
              ? [{ text: normalize(content.text, cwd) }]
              : [])
        })
      })
      const tools = (requests[0]?.tools ?? []).map(tool => ({
        name: tool.function?.name,
        required: tool.function?.parameters?.required ?? [],
      })).sort((left, right) => {
        const leftName = String(left.name)
        const rightName = String(right.name)
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
      })
      const behavior = {
        tools,
        calls,
        results,
        final: {
          status: result.status,
          reason: result.reason,
          response: result.finalResponse,
          file: await readFile(target, 'utf8'),
        },
      }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await writeFile(expectedPath, `${JSON.stringify(behavior, null, 2)}\n`)
      }
      expect(behavior).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
    } finally {
      await harness.close()
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(cwd, { recursive: true, force: true })
    }
  }, 75_000)
})
