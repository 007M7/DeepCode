import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { zstdDecompress } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const cliBin = join(repoRoot, 'packages/examples/cli-demo/lib/bin.js')
const decompress = promisify(zstdDecompress)
const dshPackages = [
  'examples/agent-spine-demo', 'examples/cli-demo', 'core/agent', 'core/session',
  'core/system-prompt', 'core/tools', 'core/agent-loop', 'llm/llm', 'bash/bash',
  'bash/bash-local', 'bash/tool-bash', 'support/invariants', 'ui/app-boot',
  'session-persistence/session-persistence', 'session-persistence/session-persistence-jsonl',
  'context/workspace-context',
]
const vendorPackages = ['cordis', 'loader', 'include', 'timer', 'schemastery', 'cosmokit']

async function packageName(dir: string): Promise<string> {
  return (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name: string }).name
}

async function linkPackage(dir: string, nodeModules: string): Promise<void> {
  const target = join(nodeModules, await packageName(dir))
  await mkdir(dirname(target), { recursive: true })
  await symlink(dir, target)
}

async function makeConsumer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-built-bin-'))
  const nodeModules = join(dir, 'node_modules')
  for (const rel of dshPackages) await linkPackage(join(repoRoot, 'packages', rel), nodeModules)
  for (const rel of vendorPackages) await linkPackage(join(repoRoot, 'vendor', rel), nodeModules)
  await writeFile(join(dir, 'mock-llm.mjs'), [
    "import { LlmAdapter } from '@deepseek-ai/dsh-llm'",
    'class Mock extends LlmAdapter {',
    '  async * stream(options) {',
    "    const text = options.messages.flatMap(message => message.content).filter(block => block.type === 'text').at(-1)?.text ?? ''",
    "    yield { type: 'block-start', index: 0, blockType: 'text' }",
    "    if (text === 'hang') {",
    "      yield { type: 'text-delta', index: 0, text: 'partial' }",
    '      await new Promise((resolve, reject) => {',
    "        const timer = setTimeout(() => reject(new Error('hang timeout')), 30000)",
    "        const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')) }",
    '        if (options.signal.aborted) onAbort()',
    "        else options.signal.addEventListener('abort', onAbort, { once: true })",
    '      })',
    '      return',
    '    }',
    '    const reply = `BUILT: ${text}`',
    "    yield { type: 'text-delta', index: 0, text: reply }",
    "    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }",
    "    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }",
    "    yield { type: 'finish', reason: { kind: 'stop' } }",
    '  }',
    '}',
    "export const name = 'built-cli-mock'",
    "export const inject = ['llm']",
    "export function apply(ctx) { ctx.llm.registerAdapter(['built-cli-mock'], new Mock()) }",
    '',
  ].join('\n'))
  await writeFile(join(dir, 'cordis.yml'), [
    '- id: mock-llm',
    "  name: './mock-llm.mjs'",
    '- id: bash',
    "  name: '@deepseek-ai/dsh-bash-local'",
    '- id: cli-agent',
    "  name: '@deepseek-ai/dsh-cli-demo'",
    '  config:',
    '    provider: built-cli-mock',
    '    model: built-cli-mock',
    "    persona: 'built CLI test'",
    "    persistenceRoot: './.sessions'",
    '    workspaceContext: false',
    '',
  ].join('\n'))
  return dir
}

interface BinResult {
  readonly code: number
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

function runBuiltBin(cwd: string, args: readonly string[], interrupt?: NodeJS.Signals): Promise<BinResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--expose-internals', cliBin, ...args], {
      cwd,
      env: { ...process.env, DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, '.agents') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let interrupted = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (interrupt !== undefined && !interrupted && stdout.includes('assistant/chunk')) {
        interrupted = true
        child.kill(interrupt)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`built CLI did not exit. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 25_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ code: code ?? -1, signal, stdout, stderr })
    })
  })
}

let consumer: string | undefined

afterEach(async () => {
  if (consumer !== undefined) await rm(consumer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  consumer = undefined
})

describe.skipIf(!existsSync(cliBin))('dsh-cli-demo BUILT bin', () => {
  it('runs text, json, and stream-json under plain Node and persists fresh sessions', async () => {
    consumer = await makeConsumer()
    const text = await runBuiltBin(consumer, ['--config', './cordis.yml', 'hello'])
    expect(text).toMatchObject({ code: 0, signal: null, stdout: 'BUILT: hello\n', stderr: '' })

    const json = await runBuiltBin(consumer, ['--config', './cordis.yml', '--output-format', 'json', 'json task'])
    expect(JSON.parse(json.stdout)).toMatchObject({
      type: 'result', success: true, result: 'BUILT: json task', reason: { kind: 'completed' },
      usage: { inputTokens: 4, outputTokens: 2 },
    })

    const stream = await runBuiltBin(consumer, ['--config', './cordis.yml', '--output-format', 'stream-json', 'stream task'])
    const lines = stream.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({ type: 'session_event', event: { type: 'turn/start' } })
    expect(lines.at(-1)).toMatchObject({ type: 'result', success: true, result: 'BUILT: stream task' })
    const sessionsRoot = join(consumer, '.sessions')
    const files = await readdir(sessionsRoot, { recursive: true })
    const logs = files.filter(file => file.endsWith('.jsonl.zstd'))
    expect(logs).toHaveLength(3)
    const compressed = await readFile(join(sessionsRoot, logs[0]!))
    expect(compressed.subarray(0, 4).toString('hex')).toBe('28b52ffd')
    expect(JSON.parse((await decompress(compressed)).toString())).toMatchObject({ type: 'session' })
  }, 30_000)

  it('keeps stdout empty for invalid argv and missing config', async () => {
    consumer = await makeConsumer()
    for (const args of [
      ['--config', './cordis.yml'],
      ['--config', './cordis.yml', 'one', 'two'],
      ['--config', './missing.yml', 'task'],
    ]) {
      const result = await runBuiltBin(consumer, args)
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr.length).toBeGreaterThan(0)
    }
  }, 30_000)

  describe.skipIf(process.platform === 'win32')('POSIX signal delivery', () => {
    it.each([
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const)('cancels and disposes on %s with exit %i', async (signal, code) => {
      consumer = await makeConsumer()
      const result = await runBuiltBin(
        consumer,
        ['--config', './cordis.yml', '--output-format', 'stream-json', 'hang'],
        signal,
      )
      expect(result, JSON.stringify(result)).toMatchObject({ code, signal: null })
      expect(result.stdout).toContain('"kind":"aborted"')
      expect(result.stderr).toContain('turn 1 was aborted')
    }, 30_000)
  })
})
