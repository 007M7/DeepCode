/**
 * Deterministic real-process proofs for runner classification: the real local
 * provider and sandbox bash executor exercise direct runner-spawn failures
 * and a POSIX fake Landlock launcher that prints its notice before exec.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  LAUNCHER_FAILURE_EXIT,
  LAUNCHER_FATAL_PREFIX,
  PARTIAL_ENFORCEMENT_NOTICE,
} from 'node-addon-landlock-run'
import { SANDBOX_UNAVAILABLE } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'

const FATAL = `${LAUNCHER_FATAL_PREFIX}landlock ruleset error: Invalid argument`

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Write a fake native launcher that reports partial enforcement, then execs or fails. */
async function fakeLauncher(fatalExit?: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-partial-landlock-'))
  tempDirs.push(dir)
  const launcher = join(dir, 'landlock-run')
  const fatalBranch = fatalExit === undefined ? '' : `printf '%s\\n' '${FATAL}' >&2\nexit ${fatalExit}\n`
  await writeFile(launcher, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ro|--rw) shift 2 ;;
    --) shift; break ;;
    *) printf '%s\\n' '${LAUNCHER_FATAL_PREFIX}usage error: unexpected fake argument' >&2; exit ${LAUNCHER_FAILURE_EXIT} ;;
  esac
done
printf '%s\\n' '${PARTIAL_ENFORCEMENT_NOTICE}' >&2
${fatalBranch}exec "$@"
`, { mode: 0o755 })
  return launcher
}

async function setup(fatalExit?: number): Promise<SandboxBashExecutor> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = {
    platform: 'linux',
    probeBwrap: () => false,
    probeLandlock: () => 'partial',
    landlockLauncher: await fakeLauncher(fatalExit),
  }
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() })
  await ctx.plugin(LocalSubprocessService)
  await ctx.plugin(SandboxBashExecutor, { cwd: process.cwd(), timeoutMs: 5_000 })
  return ctx.bash as SandboxBashExecutor
}

async function setupConfiguredRunner(runner: string): Promise<SandboxBashExecutor> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider, {
    runnerCommand: [runner],
    runnerFailureSignatures: ['configured-runner: fatal'],
  })
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() })
  await ctx.plugin(LocalSubprocessService)
  await ctx.plugin(SandboxBashExecutor, { cwd: process.cwd(), timeoutMs: 5_000 })
  return ctx.bash as SandboxBashExecutor
}

describe('partial Landlock runner-failure classification', () => {
  it.each(['missing', 'unexecutable'] as const)('classifies a %s configured runner through the direct spawn error channel', async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-unusable-sandbox-runner-'))
    tempDirs.push(dir)
    const runner = join(dir, `${kind}-runner`)
    if (kind === 'unexecutable') await writeFile(runner, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    const bash = await setupConfiguredRunner(runner)

    const error = await bash.run(bash.resolve({ command: 'true' })).catch((value: unknown) => value)
    expect(error).toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(runner)

    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(task.status).toBe('killed')
    expect(task.readOutput().delta).toContain(`spawn failed: Error: spawn ${runner}`)
    expect(task.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'full',
      runnerFailed: true,
    })
    const accounting = (bash as unknown as { processFacts: Map<unknown, unknown> }).processFacts
    expect(accounting.size).toBe(0)
  })

  it.each([0, 1, 2, LAUNCHER_FAILURE_EXIT])(
    'keeps child exit %i ordinary when the partial-enforcement notice is the only runner line',
    async (exitCode) => {
      const bash = await setup()
      const result = await bash.run(bash.resolve({ command: `exit ${exitCode}` }))
      expect(result.exitCode).toBe(exitCode)
      expect(result.stderr.text).toBe(`${PARTIAL_ENFORCEMENT_NOTICE}\n`)
      expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
    },
  )

  it.each([126, 127])('keeps a successfully launched Landlock child exit %i as an ordinary outcome', async (exitCode) => {
    const bash = await setup()
    const result = await bash.run(bash.resolve({ command: `exit ${exitCode}` }))
    expect(result.exitCode).toBe(exitCode)
    expect(result.stderr.text).toBe(`${PARTIAL_ENFORCEMENT_NOTICE}\n`)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it.each([1, 2])('keeps a Landlock fatal line at exit %i as insufficient runner-failure evidence', async (exitCode) => {
    const bash = await setup(exitCode)
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.exitCode).toBe(exitCode)
    expect(result.stderr.text).toBe(`${PARTIAL_ENFORCEMENT_NOTICE}\n${FATAL}\n`)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it('reports the fatal line after the notice as SANDBOX_UNAVAILABLE detail', async () => {
    const bash = await setup(LAUNCHER_FAILURE_EXIT)
    const error = await bash.run(bash.resolve({ command: 'true' })).catch((value: unknown) => value)
    expect(error).toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(`Runner failure: ${FATAL}`)
    expect((error as Error).message).not.toContain(PARTIAL_ENFORCEMENT_NOTICE)
  })

  it('classifies a notice plus child Permission denied as a denial, not runner failure', async () => {
    const bash = await setup()
    const result = await bash.run(bash.resolve({ command: 'printf "%s\\n" "child: Permission denied" >&2; exit 1' }))
    expect(result.stderr.text).toBe(`${PARTIAL_ENFORCEMENT_NOTICE}\nchild: Permission denied\n`)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
  })

  it('applies the same evidence rule to notice-only background exits', async () => {
    const bash = await setup()
    for (const command of ['exit 1', 'exit 2', `exit ${LAUNCHER_FAILURE_EXIT}`]) {
      const task = bash.start(bash.resolve({ command }))
      await task.done
      expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
      expect(task.readOutput().delta).toContain(PARTIAL_ENFORCEMENT_NOTICE)
    }
  })

  it('classifies a background notice plus child Permission denied as denial', async () => {
    const bash = await setup()
    const task = bash.start(bash.resolve({ command: 'printf "%s\\n" "child: Permission denied" >&2; exit 1' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    expect(task.readOutput().delta).toContain(PARTIAL_ENFORCEMENT_NOTICE)
  })

  it('makes a background fatal line outrank denial text after the notice', async () => {
    const bash = await setup(LAUNCHER_FAILURE_EXIT)
    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(task.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'partial',
      runnerFailed: true,
    })
    const output = task.readOutput().delta
    expect(output).toContain(PARTIAL_ENFORCEMENT_NOTICE)
    expect(output).toContain(FATAL)
  })
})
