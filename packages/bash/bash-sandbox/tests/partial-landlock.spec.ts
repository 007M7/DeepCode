/**
 * Deterministic composition proof for the partial-Landlock diagnostic: the
 * real local provider and sandbox bash executor wrap commands through a POSIX
 * fake launcher that prints the native informational line before exec.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { SANDBOX_UNAVAILABLE } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'

const NOTICE = 'landlock-run: partial enforcement (older Landlock ABI)'
const FATAL = 'landlock-run: landlock ruleset error: Invalid argument'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Write a fake native launcher that reports partial enforcement, then execs or fails. */
async function fakeLauncher(fatal: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-partial-landlock-'))
  tempDirs.push(dir)
  const launcher = join(dir, 'landlock-run')
  const fatalBranch = fatal ? `printf '%s\\n' '${FATAL}' >&2\nexit 125\n` : ''
  await writeFile(launcher, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ro|--rw) shift 2 ;;
    --) shift; break ;;
    *) printf '%s\\n' 'landlock-run: usage error: unexpected fake argument' >&2; exit 125 ;;
  esac
done
printf '%s\\n' '${NOTICE}' >&2
${fatalBranch}exec "$@"
`, { mode: 0o755 })
  return launcher
}

async function setup(fatal = false): Promise<SandboxBashExecutor> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = {
    platform: 'linux',
    probeBwrap: () => false,
    probeLandlock: () => 'partial',
    landlockLauncher: await fakeLauncher(fatal),
  }
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() })
  await ctx.plugin(LocalSubprocessService)
  await ctx.plugin(SandboxBashExecutor, { cwd: process.cwd(), timeoutMs: 5_000 })
  return ctx.bash as SandboxBashExecutor
}

describe('partial Landlock runner-failure classification', () => {
  it('keeps true, false, and child exit 125 as child outcomes when the notice is the only runner line', async () => {
    const bash = await setup()
    for (const [command, exitCode] of [['true', 0], ['false', 1], ['exit 125', 125]] as const) {
      const result = await bash.run(bash.resolve({ command }))
      expect(result.exitCode).toBe(exitCode)
      expect(result.stderr.text).toBe(`${NOTICE}\n`)
      expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
    }
  })

  it('reports the fatal line after the notice as SANDBOX_UNAVAILABLE detail', async () => {
    const bash = await setup(true)
    const error = await bash.run(bash.resolve({ command: 'true' })).catch((value: unknown) => value)
    expect(error).toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(`Runner failure: ${FATAL}`)
    expect((error as Error).message).not.toContain(NOTICE)
  })

  it('classifies a notice plus child Permission denied as a denial, not runner failure', async () => {
    const bash = await setup()
    const result = await bash.run(bash.resolve({ command: 'printf "%s\\n" "child: Permission denied" >&2; exit 1' }))
    expect(result.stderr.text).toBe(`${NOTICE}\nchild: Permission denied\n`)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
  })

  it('applies the same evidence rule to notice-only background exits', async () => {
    const bash = await setup()
    for (const command of ['false', 'exit 125']) {
      const task = bash.start(bash.resolve({ command }))
      await task.done
      expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
      expect(task.readOutput().delta).toContain(NOTICE)
    }
  })

  it('classifies a background notice plus child Permission denied as denial', async () => {
    const bash = await setup()
    const task = bash.start(bash.resolve({ command: 'printf "%s\\n" "child: Permission denied" >&2; exit 1' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    expect(task.readOutput().delta).toContain(NOTICE)
  })

  it('makes a background fatal line outrank denial text after the notice', async () => {
    const bash = await setup(true)
    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(task.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'partial',
      runnerFailed: true,
    })
    const output = task.readOutput().delta
    expect(output).toContain(NOTICE)
    expect(output).toContain(FATAL)
  })
})
