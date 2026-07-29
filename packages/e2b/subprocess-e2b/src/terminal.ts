/** E2B PTY allocation and process-session ownership for the subprocess seam. */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { posix } from 'node:path'
import {
  CommandExitError,
  FileNotFoundError,
  SandboxNotFoundError,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import type { CommandHandle, CommandResult, Sandbox } from '@deepseek-ai/dsh-e2b'
import { SubprocessTerminalLifecycle } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type E2BSandboxService from '@deepseek-ai/dsh-e2b'
import { readRemoteEnvironment, serializeRemoteEnvironment } from './environment.ts'

const POLL_MS = 20

const TERMINAL_RUNNER_SOURCE = [
  '#!/bin/bash',
  'set -euo pipefail',
  'dsh_state=$1',
  'mapfile -d \'\' -t dsh_env < "$dsh_state/environment"',
  'mapfile -d \'\' -t dsh_argv < "$dsh_state/argv"',
  'dsh_output_marker=$(<"$dsh_state/output-marker")',
  'rm -f -- "$dsh_state/environment" "$dsh_state/argv" "$dsh_state/output-marker" "$dsh_state/runner.bash"',
  'if (( ${#dsh_argv[@]} == 0 )); then',
  "  printf 'terminal runner received empty argv\\n' >&2",
  '  exit 125',
  'fi',
  'printf \'%s\' "$dsh_output_marker"',
  "printf 'ready\\n' > \"$dsh_state/ready\"",
  'exec env -i -- "${dsh_env[@]}" "${dsh_argv[@]}"',
  '',
].join('\n')

interface TerminalPaths {
  runner: string
  environment: string
  argv: string
  outputMarker: string
  ready: string
}

function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class BootstrapOutputFilter {
  readonly ready: Promise<void>

  private readonly readyState = Promise.withResolvers<void>()
  private pending = Buffer.alloc(0)
  private published = false

  constructor(
    private readonly marker: Buffer,
    private readonly output: PassThrough,
  ) {
    this.ready = this.readyState.promise
  }

  push(data: Uint8Array): void {
    if (this.published) {
      this.write(data)
      return
    }
    const combined = Buffer.concat([this.pending, Buffer.from(data)])
    const markerOffset = combined.indexOf(this.marker)
    if (markerOffset < 0) {
      const retained = Math.min(combined.length, this.marker.length - 1)
      this.pending = Buffer.from(combined.subarray(combined.length - retained))
      return
    }
    this.published = true
    this.pending = Buffer.alloc(0)
    this.readyState.resolve()
    this.write(combined.subarray(markerOffset + this.marker.length))
  }

  private write(data: Uint8Array): void {
    if (data.length > 0 && !this.output.destroyed) this.output.write(data)
  }
}

async function waitForBootstrapOutput(
  ready: Promise<void>,
  completion: Promise<CommandResult>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let removeAbort: (() => void) | undefined
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      removeAbort?.()
      complete()
    }
    const onExit = (): void => {
      finish(() => { reject(new Error('subprocess-e2b: terminal exited before publishing its output boundary')) })
    }
    if (signal !== undefined) {
      const onAbort = (): void => {
        finish(() => { reject(asError(signal.reason)) })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => { signal.removeEventListener('abort', onAbort) }
    }
    void ready.then(() => { finish(resolve) })
    void completion.then(onExit, onExit)
  })
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
  let result: CommandResult
  try {
    result = await sandbox.commands.run(
      `set -o pipefail; ps -eo sid=,pgid=,stat= | awk '$1 == ${sessionId} && $3 !~ /^[ZXx]/ { print $2 }'`,
    )
  } catch (error: unknown) {
    if (error instanceof SandboxNotFoundError) return []
    throw error
  }
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
    if (!(error instanceof CommandExitError) && !(error instanceof SandboxNotFoundError)) throw error
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
        if (error instanceof SandboxNotFoundError) return
        attemptFailures.push(asError(error))
      }
    }
    // The awaited PTY fallback can settle completion before the SDK fallback.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!topLevelExited) {
      try {
        await handle.kill()
      } catch (error: unknown) {
        if (error instanceof SandboxNotFoundError) return
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
  try {
    await handle.disconnect()
  } catch (error: unknown) {
    if (!(error instanceof SandboxNotFoundError)) throw error
  }
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
      if (error instanceof CommandExitError && (error.exitCode === 1 || this.topLevelExited)) return undefined
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
      if (!this.topLevelExited) {
        try {
          await this.sandbox.pty.kill(this.pid)
        } catch (error: unknown) {
          if (error instanceof SandboxNotFoundError) return
          throw error
        }
      }
      groups = await awaitSessionEmpty(this.sandbox, this.sessionId, this.graceMs, true)
      if (!this.topLevelExited) await Promise.race([this.done.catch(() => undefined), delay(this.graceMs)])
    }
    if (groups.length > 0) {
      throw new Error(`subprocess-e2b: terminal cleanup failed; surviving process groups: ${groups.join(', ')}`)
    }
    if (!this.topLevelExited) {
      throw new Error(`subprocess-e2b: terminal cleanup failed; surviving pid: ${this.pid}`)
    }
    try {
      await this.handle.disconnect()
    } catch (error: unknown) {
      if (!(error instanceof SandboxNotFoundError)) throw error
    }
    await this.sandbox.files.remove(this.stateDir).catch(() => {})
  }
}

/**
 * Allocate an E2B PTY, replace its bootstrap shell with the requested argv,
 * and return only after the private runner has published readiness.
 * @param runtime - Shared E2B sandbox owner.
 * @param spec - Fully specified terminal-process request.
 * @param stateDir - Private remote directory for one startup transaction.
 * @param retainFailedCleanup - Optional owner for retrying a cleanup transaction that could not prove quiescence.
 * @returns The live subprocess terminal handle.
 */
export async function spawnE2BTerminal(
  runtime: E2BSandboxService,
  spec: SubprocessTerminalSpawnSpec,
  stateDir: string,
  retainFailedCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<E2BTerminalHandle> {
  const sandbox = await runtime.getSandbox()
  spec.signal?.throwIfAborted()
  const paths: TerminalPaths = {
    runner: posix.join(stateDir, 'runner.bash'),
    environment: posix.join(stateDir, 'environment'),
    argv: posix.join(stateDir, 'argv'),
    outputMarker: posix.join(stateDir, 'output-marker'),
    ready: posix.join(stateDir, 'ready'),
  }
  const outputMarker = Buffer.from(`dsh-e2b-bootstrap:${randomUUID()}`)
  const output = new PassThrough()
  const outputFilter = new BootstrapOutputFilter(outputMarker, output)
  let handle: CommandHandle | undefined
  let completion: Promise<CommandResult> | undefined
  let stateDirectoryCreated = false
  try {
    const ambient = await readRemoteEnvironment(sandbox, spec.signal)
    const environment = serializeRemoteEnvironment(ambient, spec.env)
    const argv = serializeValues(spec.argv, 'argv')
    await sandbox.files.makeDir(stateDir)
    stateDirectoryCreated = true
    await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(stateDir)}`, signalOpts(spec.signal))
    await sandbox.files.write([
      { path: paths.runner, data: TERMINAL_RUNNER_SOURCE },
      { path: paths.environment, data: environment },
      { path: paths.argv, data: argv },
      { path: paths.outputMarker, data: outputMarker.toString('utf8') },
    ], signalOpts(spec.signal))
    await sandbox.commands.run(
      `chmod 600 -- ${quoteE2BShellArg(paths.runner)} ${quoteE2BShellArg(paths.environment)} ${quoteE2BShellArg(paths.argv)} ${quoteE2BShellArg(paths.outputMarker)}`,
      signalOpts(spec.signal),
    )
    handle = await sandbox.pty.create({
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      envs: { TERM: 'dumb' },
      timeoutMs: 0,
      onData: (data) => { outputFilter.push(data) },
    })
    completion = handle.wait()
    void completion.catch(() => {})
    spec.signal?.throwIfAborted()
    if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) {
      throw new Error(`subprocess-e2b: E2B returned invalid terminal pid ${handle.pid}`)
    }
    const command = `exec /bin/bash ${quoteE2BShellArg(paths.runner)} ${quoteE2BShellArg(stateDir)}\r`
    await sandbox.pty.sendInput(handle.pid, Buffer.from(command), signalOpts(spec.signal))
    await waitUntilReady(sandbox, paths, completion, spec.signal)
    await waitForBootstrapOutput(outputFilter.ready, completion, spec.signal)
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
    let terminalQuiescent = handle === undefined
    let stateRemoved = !stateDirectoryCreated
    const retryCleanup = async (): Promise<void> => {
      const failures: Error[] = []
      if (!terminalQuiescent && handle !== undefined) {
        try {
          if (completion === undefined) await handle.kill()
          else await rollbackUnpublishedTerminal(sandbox, handle, completion, spec.graceMs)
          terminalQuiescent = true
        } catch (cleanupError: unknown) {
          if (cleanupError instanceof SandboxNotFoundError) terminalQuiescent = true
          else failures.push(asError(cleanupError))
        }
      }
      if (!stateRemoved) {
        try {
          await sandbox.files.remove(stateDir)
          stateRemoved = true
        } catch (stateError: unknown) {
          if (stateError instanceof FileNotFoundError || stateError instanceof SandboxNotFoundError) stateRemoved = true
          else failures.push(asError(stateError))
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'subprocess-e2b: terminal setup cleanup did not complete')
      }
    }
    try {
      await retryCleanup()
    } catch (cleanupError: unknown) {
      retainFailedCleanup?.(retryCleanup)
      throw new AggregateError([asError(error), asError(cleanupError)], asError(error).message)
    }
    throw error
  }
}
