/**
 * E2B implementation of the subprocess seam. Each handle starts through the
 * shared sandbox and retains command output/status paths in that remote world.
 * @module @deepseek-ai/dsh-subprocess-e2b
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from 'cordis'
import { SubprocessService } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { e2bControlEnvs, quoteE2BShellArg } from '@deepseek-ai/dsh-e2b'
import { E2BSubprocessHandle } from './process.ts'
import { spawnE2BTerminal } from './terminal.ts'

function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

/** E2B command manager registered as `ctx.subprocess`. */
export class E2BSubprocessService extends SubprocessService {
  static inject = ['e2b']

  private readonly live = new Set<E2BSubprocessHandle>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()
  private readonly terminalSetups = new Map<Promise<void>, AbortController>()
  private readonly failedTerminalSetupCleanups = new Set<() => Promise<void>>()
  private disposing = false

  /** @inheritdoc */
  readonly cwd: string

  /** @inheritdoc */
  readonly runtimeRoot: string

  /** Create the E2B subprocess service and bind its disposal policy. */
  constructor(ctx: Context) {
    super(ctx)
    this.cwd = ctx.e2b.cwd
    this.runtimeRoot = ctx.e2b.runtimeRoot
    ctx.effect(() => async () => {
      this.disposing = true
      for (const controller of this.terminalSetups.values()) {
        controller.abort(new Error('subprocess-e2b: service disposed during terminal setup'))
      }
      await Promise.all([...this.terminalSetups.keys()])
      const handles = [...this.live]
      const terminals = [...this.terminals]
      const failedTerminalSetupCleanups = [...this.failedTerminalSetupCleanups]
      const pending: Promise<unknown>[] = []
      for (const handle of handles) {
        handle.terminate()
        pending.push(handle.waitForExit().then(async () => {
          await handle.done.catch(() => undefined)
          this.live.delete(handle)
        }))
      }
      for (const terminal of terminals) {
        terminal.terminate()
        pending.push(terminal.waitForExit().then(() => { this.terminals.delete(terminal) }))
      }
      for (const cleanup of failedTerminalSetupCleanups) {
        pending.push(cleanup().then(() => { this.failedTerminalSetupCleanups.delete(cleanup) }))
      }
      const outcomes = await Promise.allSettled(pending)
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason
      }
    }, 'e2b subprocess teardown')
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-e2b: executable name must be non-empty')
    signal?.throwIfAborted()
    const sandbox = await this.ctx.e2b.getSandbox()
    if (posix.isAbsolute(command)) {
      await sandbox.commands.run(
        `test -f ${quoteE2BShellArg(command)} -a -x ${quoteE2BShellArg(command)}`,
        { envs: e2bControlEnvs(), ...signalOpts(signal) },
      )
      signal?.throwIfAborted()
      return command
    }
    const path = env?.PATH
    const prefix = path === undefined ? '' : `PATH=${quoteE2BShellArg(path)} `
    const result = await sandbox.commands.run(
      `${prefix}command -v -- ${quoteE2BShellArg(command)}`,
      { cwd: this.cwd, envs: e2bControlEnvs(), ...signalOpts(signal) },
    )
    signal?.throwIfAborted()
    const executable = result.stdout.trim()
    if (executable.includes('\n') || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`subprocess-e2b: executable ${JSON.stringify(command)} did not resolve to one absolute path`)
    }
    return posix.resolve(this.cwd, executable)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.isDisposing()) throw new Error('subprocess-e2b: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
      throw new Error('subprocess-e2b: graceMs must be a positive finite number')
    }
    if (spec.signal?.aborted === true) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
    }
    const stateDir = posix.join(this.ctx.e2b.runtimeRoot, 'processes', randomUUID())
    const handle = new E2BSubprocessHandle(this.ctx.e2b, spec, stateDir)
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.isDisposing()) throw new Error('subprocess-e2b: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('subprocess-e2b: terminal argv must contain a program')
    }
    for (const [name, value] of [['rows', spec.rows], ['cols', spec.cols], ['graceMs', spec.graceMs]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`subprocess-e2b: terminal ${name} must be a positive safe integer`)
      }
    }
    spec.signal?.throwIfAborted()
    const stateDir = posix.join(this.runtimeRoot, 'terminals', randomUUID())
    const setup = Promise.withResolvers<void>()
    const setupController = new AbortController()
    const setupSignal = spec.signal === undefined
      ? setupController.signal
      : AbortSignal.any([spec.signal, setupController.signal])
    this.terminalSetups.set(setup.promise, setupController)
    try {
      const terminal = await spawnE2BTerminal(
        this.ctx.e2b,
        { ...spec, signal: setupSignal },
        stateDir,
        (cleanup) => { this.failedTerminalSetupCleanups.add(cleanup) },
      )
      this.terminals.add(terminal)
      if (this.isDisposing()) {
        terminal.terminate()
        await terminal.waitForExit()
        this.terminals.delete(terminal)
        throw new Error('subprocess-e2b: service disposed during terminal setup')
      }
      const release = async (): Promise<void> => {
        await terminal.waitForExit()
        this.terminals.delete(terminal)
      }
      void terminal.done.then(release, release).catch(() => {})
      return terminal
    } finally {
      this.terminalSetups.delete(setup.promise)
      setup.resolve()
    }
  }

  private isDisposing(): boolean {
    return this.disposing
  }
}

export default E2BSubprocessService
