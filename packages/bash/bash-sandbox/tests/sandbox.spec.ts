/**
 * Consumer-side `SandboxBashExecutor` tests. A fake Cordis sandbox service makes wrapping,
 * policy hand-off, fail-closed propagation, classification, and fact stamping deterministic;
 * real-provider integration lives in `tests/landlock.e2e.ts`. A mode-0555 directory supplies
 * the Unix denial signature used by the classifier without requiring a real sandbox runner.
 */

import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { BashRunResult, CollectedOutput } from '@deepseek-ai/dsh-bash'
import { SANDBOX_UNAVAILABLE, SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { classifyDenial, classifyRunnerFailure, shellQuote } from '../src/helpers.ts'
import type { Config } from '@deepseek-ai/dsh-bash-sandbox'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-sandbox-spec-'))

/** One recorded provider call: the argv handed over and the policy it rode with. */
interface ConfineCall {
  argv: string[]
  policy: SandboxPolicy
}

/** The Linux file-denial dialects the fake wraps carry — matches the unix-permission denials the tests below produce. */
const UNIX_SIGNATURES = ['read-only file system', 'permission denied'] as const

/** The runner-failure prefix the fake wraps carry (a fake-runner: error line marks the sandbox itself failing). */
const RUNNER_FAILURE = ['fake-runner: '] as const

/** A passthrough wrap: the caller's argv unchanged, asserted full — commands run unconfined, deterministically. */
const passthrough = (argv: readonly string[]): ConfinedArgv =>
  ({ argv: [...argv], enforcement: 'full', denialSignatures: UNIX_SIGNATURES, runnerFailureSignatures: RUNNER_FAILURE })

/**
 * Boot a context with a recording fake `ctx.sandbox` (behavior injectable
 * per test) and the executor under test on top of it.
 */
async function setup(
  config: { mode?: SandboxMode; workspaceRoot?: string } & Config = {},
  behavior: (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv = passthrough,
) {
  const { mode, workspaceRoot, ...execConfig } = config
  const calls: ConfineCall[] = []
  class FakeSandboxProvider extends SandboxProvider {
    confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
      calls.push({ argv: [...argv], policy })
      return behavior(argv, policy)
    }
  }
  const ctx = new Context()
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, {
    ...mode !== undefined ? { mode } : {},
    ...workspaceRoot !== undefined ? { workspaceRoot } : {},
  })
  await ctx.plugin(SandboxBashExecutor, { graceMs: 200, ...execConfig })
  const bash = ctx.bash as SandboxBashExecutor
  bash.internals = { spillDir }
  return { ctx, bash, calls }
}

function output(text: string): CollectedOutput {
  return { text, truncated: false }
}

function runResult(exitCode: number | null, stderr: string): BashRunResult {
  return { exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: output(''), stderr: output(stderr) }
}

function executionPolicy(mode: SandboxMode, workspaceRoot = resolve(process.cwd())): SandboxExecutionPolicy {
  return { mode, workspaceRoot }
}

describe('the provider hand-off', () => {
  it('hands the provider the exact bash argv and the per-call policy, and runs the returned argv', async () => {
    const { bash, calls } = await setup()
    const result = await bash.run(bash.resolve({ command: 'echo \'a b\' "c\'d"' }))
    expect(result.stdout.text).toBe('a b c\'d\n')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
    expect(calls).toEqual([{
      argv: ['bash', '-c', 'echo \'a b\' "c\'d"'],
      policy: { mode: 'read-only', workspaceRoot: resolve(process.cwd()) },
    }])
  })

  it('a wrapped argv from the provider is what actually spawns (prefix survives, quoting round-trips)', async () => {
    // The fake wraps with `env MARKER=...` — a real (if tiny) runner prefix:
    // the sentinel only prints if the executor spawned the WRAPPED argv.
    const { bash } = await setup({}, argv => ({ argv: ['env', 'DSH_WRAP=1', ...argv], enforcement: 'full', denialSignatures: UNIX_SIGNATURES, runnerFailureSignatures: RUNNER_FAILURE }))
    const result = await bash.run(bash.resolve({ command: 'printf "%s" "$DSH_WRAP"' }))
    expect(result.stdout.text).toBe('1')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('workspace-write rides the policy, workspaceRoot falling back to process.cwd() when not configured', async () => {
    const { bash, calls } = await setup({ mode: 'workspace-write' })
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(calls[0]?.policy).toEqual({ mode: 'workspace-write', workspaceRoot: resolve(process.cwd()) })
  })

  it('an explicit workspaceRoot on the policy wins', async () => {
    const { calls, bash } = await setup({ mode: 'workspace-write', workspaceRoot: '/ws', cwd: tmpdir() })
    await bash.run(bash.resolve({ command: 'true' }))
    expect(calls[0]?.policy.workspaceRoot).toBe(resolve('/ws'))
  })

  it('the provider is consulted per wrap (no caching in the consumer): run and start each hand off', async () => {
    const { bash, calls } = await setup()
    await bash.run(bash.resolve({ command: 'true' }))
    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(calls).toHaveLength(2)
  })

  it('shellQuote survives embedded single quotes (the argv re-assembly primitive)', () => {
    expect(shellQuote('a\'b')).toBe(String.raw`'a'\''b'`)
  })
})

describe('fail closed', () => {
  it('propagates the provider\'s structured SANDBOX_UNAVAILABLE on run() and start()', async () => {
    const { bash } = await setup({}, () => { throw new SandboxUnavailableError('read-only') })
    const spec = bash.resolve({ command: 'echo hi' })
    await expect(bash.run(spec)).rejects.toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(() => bash.start(spec)).toThrow(SandboxUnavailableError)
  })
})

describe('danger-full-access', () => {
  it('runs unwrapped: the provider is never consulted, facts carry no enforcement', async () => {
    const { bash, calls } = await setup({ mode: 'danger-full-access' })
    const result = await bash.run(bash.resolve({ command: 'echo free' }))
    expect(result.stdout.text).toBe('free\n')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(calls).toHaveLength(0)
  })

  it('start() passes through unwrapped and stamps nothing at settle', async () => {
    const { bash, calls } = await setup({ mode: 'danger-full-access' })
    const task = bash.start(bash.resolve({ command: 'echo free-bg' }))
    await task.done
    expect(task.sandbox).toBeUndefined()
    expect(task.readOutput().delta).toContain('free-bg')
    expect(calls).toHaveLength(0)
  })
})

describe('per-call sandbox policy (the session and escalation carrier)', () => {
  it('exposes the configured default as the capability fact, and resolve() stamps it', async () => {
    const { bash } = await setup()
    expect(bash.sandboxMode).toBe('read-only')
    expect(bash.resolve({ command: 'true' }).sandboxPolicy).toEqual(executionPolicy('read-only'))
  })

  it('an explicit policy outranks the default at resolve(), and the wrap follows its mode and root', async () => {
    const { bash, calls } = await setup()
    const explicit = executionPolicy('workspace-write', '/session/project')
    expect(bash.resolve({ command: 'true', sandboxPolicy: explicit }).sandboxPolicy).toEqual(explicit)
    await bash.run(bash.resolve({ command: 'true', sandboxPolicy: explicit }))
    await bash.run(bash.resolve({ command: 'true' }))
    expect(calls.map(call => call.policy)).toEqual([explicit, executionPolicy('read-only')])
  })

  it('an escalated run reports the mode it ACTUALLY ran under', async () => {
    const { bash } = await setup()
    const result = await bash.run(bash.resolve({ command: 'true', sandboxPolicy: executionPolicy('workspace-write') }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
  })

  it('escalating to danger-full-access bypasses the provider entirely — the grant, not a probe, is the authority there', async () => {
    const { bash, calls } = await setup()
    const result = await bash.run(bash.resolve({ command: 'echo free', sandboxPolicy: executionPolicy('danger-full-access') }))
    expect(result.stdout.text).toBe('free\n')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(calls).toHaveLength(0)
  })

  it('overlapping background tasks settle with their OWN modes (an escalated task next to a default one)', async () => {
    // With per-call policy, tasks under different modes are in flight at
    // once — anything keyed off the configured default would misreport the
    // escalated one at its settle stamp.
    const { bash } = await setup()
    const escalated = bash.start(bash.resolve({ command: 'sleep 0.3; echo "x: Permission denied" >&2; exit 1', sandboxPolicy: executionPolicy('workspace-write') }))
    const plain = bash.start(bash.resolve({ command: 'true' }))
    await plain.done
    await escalated.done
    expect(escalated.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full' })
    expect(plain.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('an escalated danger-full-access background task carries no facts (nothing confined it)', async () => {
    const { bash, calls } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo bg-free', sandboxPolicy: executionPolicy('danger-full-access') }))
    await task.done
    expect(task.sandbox).toBeUndefined()
    expect(task.readOutput().delta).toContain('bg-free')
    expect(calls).toHaveLength(0)
  })
})

describe('classifyDenial', () => {
  it('never classifies a clean exit or a signal kill as a denial', () => {
    expect(classifyDenial(runResult(0, 'Permission denied'), UNIX_SIGNATURES)).toBe(false)
    expect(classifyDenial(runResult(null, 'Permission denied'), UNIX_SIGNATURES)).toBe(false)
  })

  it('classifies failed runs by the wrap\'s own dialect, conservatively', () => {
    expect(classifyDenial(runResult(1, 'touch: cannot touch /x: Read-only file system'), UNIX_SIGNATURES)).toBe(true)
    expect(classifyDenial(runResult(1, 'sh: /x: Permission denied'), UNIX_SIGNATURES)).toBe(true)
    // Bare EPERM is not a Linux runner's dialect: mount/kill/ptrace fail with
    // it unsandboxed too, and the mode vocabulary governs file effects only —
    // claiming a file denial here would tell the model the sandbox blocked
    // something it never governed.
    expect(classifyDenial(runResult(1, 'mount: Operation not permitted'), UNIX_SIGNATURES)).toBe(false)
    expect(classifyDenial(runResult(1, 'No such file or directory'), UNIX_SIGNATURES)).toBe(false)
  })

  it('matches exactly the active backend\'s dialect: EPERM classifies under Seatbelt, EACCES does not under bwrap', () => {
    // The same stderr flips meaning with the backend: under Seatbelt, EPERM
    // text IS how the kernel refuses a governed file write; under bwrap's
    // EROFS-only dialect, `Permission denied` is ordinary DAC, not the
    // sandbox — per-wrap signatures are what keep both classifications honest.
    expect(classifyDenial(runResult(1, 'bash: /etc/x: Operation not permitted'), ['operation not permitted'])).toBe(true)
    expect(classifyDenial(runResult(1, 'sh: /x: Permission denied'), ['read-only file system'])).toBe(false)
  })
})

describe('classifyRunnerFailure', () => {
  it('matches the dialect case-insensitively on BOTH sides — the seam declares it so, and producers compose signatures from runtime data (an argv0 path, the shell\'s `No such file or directory`)', () => {
    const signatures = ['exec: /Opt/Runners/bwrap: not found', '/Opt/Runners/bwrap: No such file or directory']
    expect(classifyRunnerFailure(runResult(127, 'bash: /Opt/Runners/bwrap: No such file or directory'), signatures)).toBe(true)
    expect(classifyRunnerFailure(runResult(127, 'BASH: LINE 1: EXEC: /OPT/RUNNERS/BWRAP: NOT FOUND'), signatures)).toBe(true)
  })
})

describe('result facts', () => {
  it('reports a real permission failure as a sandbox denial with the mode it ran under', async () => {
    const { bash } = await setup()
    const lockedDir = join(mkdtempSync(join(tmpdir(), 'dsh-sandbox-denied-')), 'locked')
    mkdirSync(lockedDir)
    chmodSync(lockedDir, 0o555)
    const result = await bash.run(bash.resolve({ command: `echo x > ${lockedDir}/f` }))
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
  })

  it('carries the provider\'s partial-enforcement fact through unchanged', async () => {
    const { bash } = await setup({}, argv => ({ argv: [...argv], enforcement: 'partial', denialSignatures: UNIX_SIGNATURES, runnerFailureSignatures: RUNNER_FAILURE }))
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })
})

describe('background sandbox facts', () => {
  it('stamps facts and releases accounting when background spawn fails', async () => {
    const { bash } = await setup()
    const missingWorkdir = join(mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-')), 'missing')
    const task = bash.start(bash.resolve({ command: 'true', workdir: missingWorkdir }))

    await task.done

    expect(task.status).toBe('killed')
    expect(task.readOutput().delta).toContain('spawn failed:')
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
    const accounting = (bash as unknown as { processFacts: Map<unknown, unknown> }).processFacts
    expect(accounting.size).toBe(0)
  })

  it('stamps a settled denial: nonzero exit + permission stderr under a confined mode', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "x: Permission denied" >&2; exit 1' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
  })

  it('a foreground runner failure throws the fail-closed error, never a task result', async () => {
    // The wrap's runner prefix on a failed run means the SANDBOX broke and
    // the command never ran — the late twin of the confine-time throw, with
    // the runner's own first stderr line carried as the cause.
    const { bash } = await setup()
    const run = bash.run(bash.resolve({ command: 'echo "fake-runner: ruleset rejected" >&2; exit 125' }))
    await expect(run).rejects.toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
    await expect(run).rejects.toThrow('fake-runner: ruleset rejected')
  })

  it('a foreground runner failure outranks denial: runner error text may contain denial words', async () => {
    const { bash } = await setup()
    await expect(bash.run(bash.resolve({ command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125' })))
      .rejects.toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
  })

  it('a settled background runner failure stamps runnerFailed (no error channel remains), not denied', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true })
  })

  it('overlapping background tasks keep their OWN wrap facts (per-task, not latest-wrap)', async () => {
    // Facts belong to each wrap and may vary between calls. The slow task settles after the
    // quick task starts; a shared latest-wrap field would classify and stamp it with the wrong
    // task's dialect and enforcement.
    const wraps: Array<Pick<ConfinedArgv, 'enforcement' | 'denialSignatures'>> = [
      { enforcement: 'partial', denialSignatures: ['permission denied'] },
      { enforcement: 'full', denialSignatures: ['read-only file system'] },
    ]
    let call = 0
    const { bash } = await setup({}, (argv) => {
      const wrap = wraps[Math.min(call++, wraps.length - 1)] as Pick<ConfinedArgv, 'enforcement' | 'denialSignatures'>
      return { argv: [...argv], ...wrap, runnerFailureSignatures: RUNNER_FAILURE }
    })
    const slow = bash.start(bash.resolve({ command: 'sleep 0.4; echo "x: Permission denied" >&2; exit 1' }))
    const quick = bash.start(bash.resolve({ command: 'true' }))
    await quick.done
    await slow.done
    expect(slow.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    expect(quick.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('a signal-killed task is never a denial (null exit code)', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "Permission denied" >&2; sleep 30' }))
    // Let the stderr land before the kill so the classifier sees the
    // signature and must still refuse it on the null exit code alone.
    await vi.waitFor(() => { expect(task.readOutput().delta).toContain('Permission denied') })
    task.kill()
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('disposal kills wrapped background tasks (inherited HMR safety)', async () => {
    const { ctx, bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'sleep 30' }))
    await ctx.fiber.dispose()
    expect(task.status).toBe('killed')
  })
})
