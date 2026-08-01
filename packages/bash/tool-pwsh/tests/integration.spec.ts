/**
 * Integration tests: the REAL `@deepseek-ai/dsh-pwsh-local` executor plus the
 * `pwsh` tool, exercised through `ctx.tools.execute()` with a real PowerShell
 * process. These verify the world — actual commands run, stdout/stderr come
 * back, exit codes render, timeouts abort, and per-session cwd resolution
 * works. The suite self-skips when no `pwsh` is on PATH (a CI accommodation
 * for hosts without PowerShell); the fake-executor suite (tools.spec.ts)
 * carries the coverage gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'

const testToolSignal = new AbortController().signal

const hasPwsh = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0

/** Normalize PowerShell's platform line endings (CRLF on Windows, LF elsewhere). */
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

let dir: string
let ctx: Context

let callCounter = 0
function call(name: string, args: unknown, agentObj?: object, signal?: AbortSignal) {
  return ctx.tools.execute({
    signal: signal ?? testToolSignal,
    callId: CallId(`it-${++callCounter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe.skipIf(!hasPwsh)('pwsh tool over the real pwsh executor', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-pwsh-'))
    await writeFile(join(dir, 'greeting.txt'), 'hello pwsh\n')

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(LocalSubprocessService)
    await ctx.plugin(PwshLocalExecutor, { timeoutMs: 20_000, graceMs: 200 })
    await ctx.plugin(ToolPwsh)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const agent = () => ({ session: { header: { id: 'session-int', cwd: dir } } })

  it('runs a command and returns stdout with the exit marker', async () => {
    const result = await call('pwsh', { command: 'Write-Output hi', description: 'say hi' }, agent())
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected pwsh success')
    expect(result.value).toMatchObject({ kind: 'foreground', exitCode: 0 })
    expect(lf(text(result))).toBe('hi\n[exit code: 0]')
  })

  it('returns stderr in a marked section and a nonzero exit as a marker, not an error', async () => {
    const result = await call('pwsh', {
      command: '[Console]::Error.WriteLine("boom"); exit 3',
      description: 'fail loudly',
    }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('[stderr]\nboom\n[exit code: 3]')
  })

  it('resolves relative paths in the session workspace', async () => {
    const result = await call('pwsh', {
      command: 'Get-Content greeting.txt',
      description: 'read greeting',
    }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('hello pwsh\n[exit code: 0]')
  })

  it('a per-call timeout kills the run and reports the timed-out marker, not an error', async () => {
    const result = await call('pwsh', {
      command: 'Start-Sleep -Seconds 60',
      description: 'sleep forever',
      timeoutMs: 100,
    }, agent())
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a timed-out foreground result')
    expect(result.value).toMatchObject({ kind: 'foreground', timedOut: true, aborted: false })
    // Windows reports the forced termination as exit 1 without a signal;
    // POSIX reports SIGTERM — the timeout marker is the stable fact.
    expect(lf(text(result))).toContain('[timed out after 100ms]')
  })

  it('an upstream cancellation aborts the run', async () => {
    const controller = new AbortController()
    const pending = call('pwsh', {
      command: 'Start-Sleep -Seconds 60',
      description: 'sleep forever',
    }, agent(), controller.signal)
    setTimeout(() => { controller.abort() }, 50)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED } })
  })
})
