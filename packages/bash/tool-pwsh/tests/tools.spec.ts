/**
 * Consumer-surface tests for the `pwsh` tool over a FAKE bash executor,
 * exercised through `ctx.tools.execute()` so nothing bypasses the tool
 * registry. The fake executor makes every seam outcome scriptable — output
 * text, truncation, timeout, abort, nonzero exits — so these tests verify the
 * schema, argument validation, workdir derivation, managed `DSH_*` collection,
 * abort translation, canonical result projection, rendering, and the UI
 * presenters. Real-pwsh behavior is pinned separately in integration.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { BashExecutor } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from '@deepseek-ai/dsh-bash'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'

const testToolSignal = new AbortController().signal

/**
 * A scriptable fake executor: `resolve()` mirrors the real defaulting, `run()`
 * returns the armed script, `start()` throws — the pwsh tool must NEVER create
 * a background task.
 */
class FakeBash extends BashExecutor {
  requests: BashExecRequest[] = []
  specs: BashExecSpec[] = []
  startCalls = 0
  handler: (spec: BashExecSpec) => BashRunResult = () => runResult('')

  override resolve(request: BashExecRequest): BashExecSpec {
    this.requests.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async run(spec: BashExecSpec): Promise<BashRunResult> {
    this.specs.push(spec)
    return this.handler(spec)
  }

  override start(): BashProcess {
    this.startCalls++
    throw new Error('the pwsh tool must never start a background task')
  }
}

/** A successful run result over the given stdout; overrides script the failure shapes. */
function runResult(stdout: string, overrides?: Partial<BashRunResult>): BashRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 60_000,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

async function setup(config: Partial<ToolPwsh.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(FakeBash)
  await ctx.plugin(ToolPwsh, config)
  const bash = ctx.bash as FakeBash
  return { ctx, bash }
}

/** A stand-in agent whose session header carries the given cwd and id. */
const agent = (cwd?: string, id = 'session-1') => ({ session: { header: { id, ...cwd !== undefined ? { cwd } : {} } } })

let callCounter = 0
function call(
  ctx: Context,
  name: string,
  args: unknown,
  options: { agent?: object; signal?: AbortSignal } = {},
) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...options.agent ? { agent: options.agent as never } : {},
    ...options.signal ? { signal: options.signal } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('registration', () => {
  it('registers the pwsh tool with its prompt section and schema', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'pwsh')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('PowerShell command')
    expect(schema?.parameters.properties).toMatchObject({
      command: { type: 'string' },
      description: { type: 'string' },
      timeoutMs: { type: 'number' },
      workdir: { type: 'string' },
    })
    expect(schema?.parameters.required).toEqual(['command', 'description'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Check the [exit code: N] marker on every pwsh result')
  })

  it('stays pending until ctx.bash exists (inject)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(ToolPwsh)
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('unregisters everything on fiber disposal (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(FakeBash)
    const fiber = await ctx.plugin(ToolPwsh)
    expect(ctx.tools.schemas()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
  })
})

describe('argument validation', () => {
  it('rejects a blank command or description and a non-positive timeoutMs', async () => {
    const { ctx } = await setup()
    expect(text(await call(ctx, 'pwsh', { command: '  ', description: 'd' }))).toContain('expected a non-empty string')
    expect(text(await call(ctx, 'pwsh', { command: 'Write-Output hi', description: ' ' }))).toContain('expected a non-empty string')
    expect(text(await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'd', timeoutMs: -1 })))
      .toContain('invalid timeoutMs: expected a positive number')
  })
})

describe('execution through the bash seam', () => {
  it('forwards command, session cwd, timeout, and managed DSH_* environment', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-tool-pwsh-home-'))
    const { ctx, bash } = await setup({ dshHome })
    bash.handler = () => runResult('hi\n')
    const result = await call(ctx, 'pwsh', {
      command: 'Write-Output hi',
      description: 'say hi',
      timeoutMs: 1234,
    }, { agent: agent('/sessions/s1') })
    expect(result.isError).toBe(false)
    const request = bash.requests[0]
    expect(request?.command).toBe('Write-Output hi')
    expect(request?.workdir).toBe('/sessions/s1')
    expect(request?.timeoutMs).toBe(1234)
    expect(request?.dshEnv).toEqual({
      DSH_HOME: dshHome,
      DSH_SHELL: '1',
      DSH_SESSION_ID: 'session-1',
    })
    expect(bash.specs[0]?.workdir).toBe('/sessions/s1')
  })

  it('resolves a relative workdir against the session cwd, absolute ones verbatim', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('ok\n')
    await call(ctx, 'pwsh', { command: 'pwd', description: 'cwd', workdir: 'sub/dir' }, { agent: agent('/sessions/s1') })
    expect(bash.requests[0]?.workdir).toBe(resolvePath('/sessions/s1', 'sub/dir'))
    await call(ctx, 'pwsh', { command: 'pwd', description: 'cwd', workdir: resolvePath('/abs/path') }, { agent: agent('/sessions/s1') })
    expect(bash.requests[1]?.workdir).toBe(resolvePath('/abs/path'))
  })

  it('omits workdir and the session id without an agent, so executor defaulting applies', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('ok\n')
    await call(ctx, 'pwsh', { command: 'Write-Output ok', description: 'ok' })
    expect(bash.requests[0]).not.toHaveProperty('workdir')
    const dshEnv = bash.requests[0]?.dshEnv
    expect(dshEnv).toBeDefined()
    expect(dshEnv?.['DSH_SHELL']).toBe('1')
    expect(dshEnv?.['DSH_HOME']).toEqual(expect.any(String))
    expect(dshEnv).not.toHaveProperty('DSH_SESSION_ID')
  })

  it('forwards exec.signal into the resolved request', async () => {
    const { ctx, bash } = await setup()
    const controller = new AbortController()
    bash.handler = () => runResult('ok\n')
    await call(ctx, 'pwsh', { command: 'Write-Output ok', description: 'ok' }, { signal: controller.signal })
    expect(bash.requests[0]?.signal).toBe(controller.signal)
  })

  it('projects the canonical foreground result with stdout, stderr, and exit facts', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('out\n', {
      exitCode: 2,
      stderr: { text: 'err\n', truncated: false },
      timeoutMs: 5000,
    })
    const result = await call(ctx, 'pwsh', { command: 'failing', description: 'fail' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected pwsh success')
    expect(result.value).toEqual({
      kind: 'foreground',
      exitCode: 2,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 5000,
      stdout: { text: 'out\n', truncated: false },
      stderr: { text: 'err\n', truncated: false },
    })
    expect(text(result)).toBe('out\n[stderr]\nerr\n[exit code: 2]')
  })

  it('renders the truncation tail, the exit marker, and a timeout marker from the executor streams', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('tail', {
      stdout: { text: 'tail', truncated: true, spillPath: '/spill/out.log' },
      stderr: { text: '', truncated: false },
    })
    const result = await call(ctx, 'pwsh', { command: 'noisy', description: 'noise' })
    expect(text(result)).toBe('tail\n[exit code: 0]')

    bash.handler = () => runResult('', { timedOut: true, exitCode: null, signal: 'SIGTERM', timeoutMs: 500 })
    const timedOut = await call(ctx, 'pwsh', { command: 'slow', description: 'slow' })
    // A timeout kill carries both facts, mirroring the bash tool's markers.
    expect(text(timedOut)).toBe('[timed out after 500ms]\n[killed by signal: SIGTERM]')
  })

  it('translates an aborted run into the TOOL_ABORTED HarnessError', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { aborted: true, exitCode: null, signal: 'SIGTERM' })
    const result = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'sleep' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED } })
  })

  it('never starts a background task', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('ok\n')
    await call(ctx, 'pwsh', { command: 'Write-Output ok', description: 'ok' })
    bash.handler = () => runResult('', { exitCode: 1 })
    await call(ctx, 'pwsh', { command: 'missing', description: 'missing' })
    expect(bash.startCalls).toBe(0)
  })
})

describe('UI presentation', () => {
  it('a real execute renders the console view through the tool definition presenter', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('hi\n')
    const args = { command: 'Write-Output hi', description: 'say hi' }
    const result = await call(ctx, 'pwsh', args, { agent: agent('/w') })
    const view = ctx.tools.get('pwsh')?.presentResult?.(args, result)
    expect(view).toEqual({
      card: 'generic',
      content: [{ type: 'text', text: '```console\nhi\n[exit code: 0]\n```' }],
    })
  })

  it('the pending call view is a terminal card carrying command, description, and optional cwd', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('pwsh')
    expect(definition?.presentCall?.({ command: 'Get-Process', description: 'List processes' }))
      .toEqual({ card: 'terminal', title: 'Get-Process', description: 'List processes' })
    expect(definition?.presentCall?.({ command: 'Get-Process', description: 'List processes', workdir: 'C:\\work' }))
      .toMatchObject({ cwd: 'C:\\work' })
  })

  it('presentResult falls back to undefined for multi-block or non-text content', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('pwsh')
    const args = { command: 'Write-Output hi', description: 'say hi' }
    const multi = { content: [{ type: 'text' as const, text: 'a' }, { type: 'text' as const, text: 'b' }], isError: false }
    expect(definition?.presentResult?.(args, multi as never)).toBeUndefined()
    const image = { content: [{ type: 'image' as const, text: 'a' }], isError: false }
    expect(definition?.presentResult?.(args, image as never)).toBeUndefined()
  })
})
