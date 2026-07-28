/** E2B PTY allocation and process-session ownership for the subprocess seam. */

import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import { posix } from 'node:path'
import {
  CommandExitError,
  FileNotFoundError,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import type { CommandHandle, CommandResult, Sandbox } from '@deepseek-ai/dsh-e2b'
import { SENSITIVE_ENV_PATTERN, SubprocessTerminalLifecycle } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type E2BSandboxService from '@deepseek-ai/dsh-e2b'

const POLL_MS = 20

const TERMINAL_RUNNER_SOURCE = [
  '#!/bin/bash',
  'set -euo pipefail',
  'dsh_state=$1',
  'mapfile -d \'\' -t dsh_env < "$dsh_state/environment"',
  'mapfile -d \'\' -t dsh_argv < "$dsh_state/argv"',
  'rm -f -- "$dsh_state/environment" "$dsh_state/argv" "$dsh_state/runner.bash"',
  'if (( ${#dsh_argv[@]} == 0 )); then',
  "  printf 'terminal runner received empty argv\\n' >&2",
  '  exit 125',
  'fi',
  "printf 'ready\\n' > \"$dsh_state/ready\"",
  'exec env -i "${dsh_env[@]}" "${dsh_argv[@]}"',
  '',
].join('\n')

interface TerminalPaths {
  runner: string
  environment: string
  argv: string
  ready: string
}

function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function parsePositiveId(value: string, message: string): number {
  const raw = value.trim()
  const id = Number(raw)
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) throw new Error(message)
  return id
}

function serializeValues(values: readonly string[], kind: string): string {
  for (const value of values) {
    if (value.includes('\0')) throw new Error(`subprocess-e2b: terminal ${kind} must not contain NUL bytes`)
  }
  return values.map(value => `${value}\0`).join('')
}

function remoteEnvironment(raw: string, explicit: Readonly<Record<string, string>> | undefined): string {
  const environment = new Map<string, string>()
  for (const entry of raw.split('\0')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const name = entry.slice(0, separator)
    if (name.startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(name)) continue
    environment.set(name, entry.slice(separator + 1))
  }
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new Error('subprocess-e2b: terminal environment entries require non-empty NUL-free names without = and NUL-free values')
    }
    environment.set(name, value)
  }
  return serializeValues([...environment].map(([name, value]) => `${name}=${value}`), 'environment')
}

async function terminalSessionId(sandbox: Sandbox, pid: number, signal?: AbortSignal): Promise<number> {
  const result = await sandbox.commands.run(`ps -o sid= -p ${pid}`, signalOpts(signal))
  signal?.throwIfAborted()
  return parsePositiveId(result.stdout, `subprocess-e2b: cannot resolve process session for terminal ${pid}`)
}

async function waitUntilReady(
  sandbox: Sandbox,
  paths: TerminalPaths,
  completion: Promise<CommandResult>,
  signal?: AbortSignal,
): Promise<void> {
  const settled = completion.then(() => true, () => true)
  for (;;) {
    signal?.throwIfAborted()
    try {
      if ((await sandbox.files.read(paths.ready, signalOpts(signal))).trim() === 'ready') return
    } catch (error: unknown) {
      if (!(error instanceof FileNotFoundError)) throw error
    }
    if (await Promise.race([settled, delay(POLL_MS).then(() => false)])) {
      throw new Error('subprocess-e2b: terminal exited before publishing readiness')
    }
  }
}

async function sessionProcessGroups(sandbox: Sandbox, sessionId: number): Promise<number[]> {
  const result = await sandbox.commands.run(
    `ps -eo sid=,pgid= | awk '$1 == ${sessionId} { print $2 }'`,
  )
  const groups = new Set<number>()
  for (const raw of result.stdout.trim().split(/\s+/)) {
    if (raw.length === 0) continue
    const group = parsePositiveId(
      raw,
      `subprocess-e2b: invalid process group ${JSON.stringify(raw)} in terminal session ${sessionId}`,
    )
    if (group <= 1) {
      throw new Error(`subprocess-e2b: unsafe process group ${group} in terminal session ${sessionId}`)
    }
    groups.add(group)
  }
  return [...groups]
}

async function signalGroups(sandbox: Sandbox, groups: number[], signal: 'TERM' | 'KILL'): Promise<void> {
  try {
    await sandbox.commands.run(`kill -${signal} -- ${groups.map(group => `-${group}`).join(' ')}`)
  } catch (error: unknown) {
    if (!(error instanceof CommandExitError)) throw error
  }
}

async function awaitSessionEmpty(
  sandbox: Sandbox,
  sessionId: number,
  graceMs: number,
  kill = false,
): Promise<number[]> {
  const deadline = Date.now() + graceMs
  for (;;) {
    const groups = await sessionProcessGroups(sandbox, sessionId)
    if (groups.length === 0 || Date.now() >= deadline) return groups
    if (kill) await signalGroups(sandbox, groups, 'KILL')
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())))
  }
}

async function rollbackUnpublishedTerminal(
  sandbox: Sandbox,
  handle: CommandHandle,
  completion: Promise<CommandResult>,
  graceMs: number,
): Promise<void> {
  let topLevelExited = false
  void completion.then(
    () => { topLevelExited = true },
    () => { topLevelExited = true },
  )
  const validPid = Number.isSafeInteger(handle.pid) && handle.pid > 1
  const attemptFailures: Error[] = []
  let sessionId: number | undefined
  if (validPid) {
    sessionId = handle.pid
    try {
      sessionId = await terminalSessionId(sandbox, handle.pid)
    } catch (_sessionLookupFailure) {
      // E2B's PTY leader is also the provisional POSIX session leader, so its
      // PID remains usable after the setup lookup itself fails or is canceled.
    }
    try {
      let groups = await sessionProcessGroups(sandbox, sessionId)
      if (groups.length > 0) {
        await signalGroups(sandbox, groups, 'TERM')
        groups = await awaitSessionEmpty(sandbox, sessionId, graceMs)
      }
      if (groups.length > 0) {
        await signalGroups(sandbox, groups, 'KILL')
        await awaitSessionEmpty(sandbox, sessionId, graceMs, true)
      }
    } catch (error: unknown) {
      attemptFailures.push(asError(error))
    }
  }
  // Completion can settle while any awaited provider cleanup above is running.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!topLevelExited) {
    if (validPid) {
      try {
        await sandbox.pty.kill(handle.pid)
      } catch (error: unknown) {
        attemptFailures.push(asError(error))
      }
    }
    // The awaited PTY fallback can settle completion before the SDK fallback.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!topLevelExited) {
      try {
        await handle.kill()
      } catch (error: unknown) {
        attemptFailures.push(asError(error))
      }
    }
    await Promise.race([completion.catch(() => undefined), delay(graceMs)])
  }
  const proofFailures: Error[] = []
  if (sessionId !== undefined) {
    try {
      const groups = await awaitSessionEmpty(sandbox, sessionId, graceMs, true)
      if (groups.length > 0) {
        proofFailures.push(new Error(
          `subprocess-e2b: terminal setup rollback failed; surviving process groups: ${groups.join(', ')}`,
        ))
      }
    } catch (error: unknown) {
      proofFailures.push(asError(error))
    }
  }
  // The bounded completion race above updates this callback-owned state.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!topLevelExited) {
    proofFailures.push(new Error(`subprocess-e2b: terminal setup rollback failed; surviving pid: ${handle.pid}`))
  }
  if (proofFailures.length > 0) {
    throw new AggregateError(
      [...attemptFailures, ...proofFailures],
      'subprocess-e2b: terminal setup rollback did not reach quiescence',
    )
  }
  await handle.disconnect()
}

/** One E2B PTY and all process groups in its remote process session. */
export class E2BTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly done: Promise<SubprocessOutcome>

  private topLevelExited = false
  private readonly lifecycle: SubprocessTerminalLifecycle
  private terminationSignal: NodeJS.Signals | null = null

  constructor(
    private readonly sandbox: Sandbox,
    private readonly handle: CommandHandle,
    readonly output: PassThrough,
    private readonly completion: Promise<CommandResult>,
    private readonly sessionId: number,
    private readonly stateDir: string,
    private readonly graceMs: number,
    signal?: AbortSignal,
  ) {
    this.pid = handle.pid
    this.done = this.waitForCommand()
    this.lifecycle = new SubprocessTerminalLifecycle({
      done: this.done,
      cleanup: () => this.closeOnce(),
      signal,
    })
  }

  /** @inheritdoc */
  async write(data: Uint8Array): Promise<void> {
    if (this.topLevelExited) throw new Error('terminal process has exited')
    await this.sandbox.pty.sendInput(this.pid, data)
  }

  /** @inheritdoc */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    try {
      const result = await this.sandbox.commands.run(`ps -o tpgid= -p ${this.pid}`)
      return {
        processGroupId: parsePositiveId(
          result.stdout,
          `subprocess-e2b: cannot resolve foreground process group for terminal ${this.pid}`,
        ),
        // E2B exposes process-table commands but not the /proc memory access
        // needed to prove a specific syscall is waiting on fd 0.
        inputWaiting: false,
      }
    } catch (error: unknown) {
      if (error instanceof CommandExitError && this.topLevelExited) return undefined
      throw error
    }
  }

  /** @inheritdoc */
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const foreground = await this.inspectForeground()
    if (foreground === undefined) {
      throw new Error(`subprocess-e2b: cannot resolve foreground process group for terminal ${this.pid}`)
    }
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    await this.sandbox.commands.run(`kill -${signal.slice(3)} -- -${foreground.processGroupId}`)
    return foreground.processGroupId
  }

  /** @inheritdoc */
  terminate(): void {
    this.lifecycle.terminate()
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    return await this.lifecycle.waitForExit(signal)
  }

  private async waitForCommand(): Promise<SubprocessOutcome> {
    try {
      const result = await this.completion
      return { exitCode: result.exitCode, signal: null }
    } catch (error: unknown) {
      if (error instanceof CommandExitError) {
        return this.terminationSignal === null
          ? { exitCode: error.exitCode, signal: null }
          : { exitCode: null, signal: this.terminationSignal }
      }
      this.output.destroy(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      this.topLevelExited = true
      if (!this.output.destroyed) this.output.end()
    }
  }

  private async closeOnce(): Promise<void> {
    let groups = await sessionProcessGroups(this.sandbox, this.sessionId)
    if (groups.length > 0) {
      this.terminationSignal = 'SIGTERM'
      await signalGroups(this.sandbox, groups, 'TERM')
      groups = await awaitSessionEmpty(this.sandbox, this.sessionId, this.graceMs)
    }
    if (groups.length === 0 && !this.topLevelExited) {
      await Promise.race([this.done.catch(() => undefined), delay(this.graceMs)])
    }
    if (groups.length > 0 || !this.topLevelExited) {
      this.terminationSignal = 'SIGKILL'
      if (!this.topLevelExited) await this.sandbox.pty.kill(this.pid)
      groups = await awaitSessionEmpty(this.sandbox, this.sessionId, this.graceMs, true)
      if (!this.topLevelExited) await Promise.race([this.done.catch(() => undefined), delay(this.graceMs)])
    }
    if (groups.length > 0) {
      throw new Error(`subprocess-e2b: terminal cleanup failed; surviving process groups: ${groups.join(', ')}`)
    }
    if (!this.topLevelExited) {
      throw new Error(`subprocess-e2b: terminal cleanup failed; surviving pid: ${this.pid}`)
    }
    await this.handle.disconnect()
    await this.sandbox.files.remove(this.stateDir).catch(() => {})
  }
}

/**
 * Allocate an E2B PTY, replace its bootstrap shell with the requested argv,
 * and return only after the private runner has published readiness.
 * @param runtime - Shared E2B sandbox owner.
 * @param spec - Fully specified terminal-process request.
 * @param stateDir - Private remote directory for one startup transaction.
 * @returns The live subprocess terminal handle.
 */
export async function spawnE2BTerminal(
  runtime: E2BSandboxService,
  spec: SubprocessTerminalSpawnSpec,
  stateDir: string,
): Promise<E2BTerminalHandle> {
  const sandbox = await runtime.getSandbox()
  spec.signal?.throwIfAborted()
  const paths: TerminalPaths = {
    runner: posix.join(stateDir, 'runner.bash'),
    environment: posix.join(stateDir, 'environment'),
    argv: posix.join(stateDir, 'argv'),
    ready: posix.join(stateDir, 'ready'),
  }
  const ambient = await sandbox.commands.run('env -0', signalOpts(spec.signal))
  const environment = remoteEnvironment(ambient.stdout, spec.env)
  const argv = serializeValues(spec.argv, 'argv')
  await sandbox.files.makeDir(stateDir)
  await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(stateDir)}`, signalOpts(spec.signal))
  await sandbox.files.write([
    { path: paths.runner, data: TERMINAL_RUNNER_SOURCE },
    { path: paths.environment, data: environment },
    { path: paths.argv, data: argv },
  ], signalOpts(spec.signal))
  await sandbox.commands.run(
    `chmod 600 -- ${quoteE2BShellArg(paths.runner)} ${quoteE2BShellArg(paths.environment)} ${quoteE2BShellArg(paths.argv)}`,
    signalOpts(spec.signal),
  )

  const output = new PassThrough()
  let handle: CommandHandle | undefined
  let completion: Promise<CommandResult> | undefined
  try {
    handle = await sandbox.pty.create({
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      envs: { TERM: 'dumb' },
      timeoutMs: 0,
      ...signalOpts(spec.signal),
      onData: (data) => { if (!output.destroyed) output.write(Buffer.from(data)) },
    })
    completion = handle.wait()
    void completion.catch(() => {})
    if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) {
      throw new Error(`subprocess-e2b: E2B returned invalid terminal pid ${handle.pid}`)
    }
    const command = `exec /bin/bash ${quoteE2BShellArg(paths.runner)} ${quoteE2BShellArg(stateDir)}\r`
    await sandbox.pty.sendInput(handle.pid, Buffer.from(command), signalOpts(spec.signal))
    await waitUntilReady(sandbox, paths, completion, spec.signal)
    const sessionId = await terminalSessionId(sandbox, handle.pid, spec.signal)
    return new E2BTerminalHandle(
      sandbox,
      handle,
      output,
      completion,
      sessionId,
      stateDir,
      spec.graceMs,
      spec.signal,
    )
  } catch (error: unknown) {
    output.destroy()
    let cleanupError: Error | undefined
    if (handle !== undefined && completion !== undefined) {
      try {
        await rollbackUnpublishedTerminal(sandbox, handle, completion, spec.graceMs)
      } catch (rollbackError: unknown) {
        cleanupError = asError(rollbackError)
      }
    } else if (handle !== undefined) {
      await handle.kill().catch(() => false)
    }
    await sandbox.files.remove(stateDir).catch(() => {})
    if (cleanupError !== undefined) {
      throw new AggregateError([asError(error), cleanupError], asError(error).message)
    }
    throw error
  }
}
