/** One asynchronously-started E2B command projected onto the subprocess seam. */

import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'
import { posix } from 'node:path'
import {
  CommandExitError,
  FileNotFoundError,
  SandboxNotFoundError,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import type { CommandHandle, CommandResult, Sandbox } from '@deepseek-ai/dsh-e2b'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type E2BSandboxService from '@deepseek-ai/dsh-e2b'
import { readRemoteEnvironment, serializeRemoteEnvironment } from './environment.ts'
import { E2BBase64Decoder, E2B_OUTPUT_COMPLETE_FRAME, E2BOutputReader } from './output.ts'

const GROUP_POLL_MS = 20
const OUTPUT_ENCODER_SOURCE = [
  '(async () => {',
  '  for await (const chunk of process.stdin) {',
  "    if (!process.stdout.write(chunk.toString('base64') + '\\n')) {",
  "      await new Promise(resolve => process.stdout.once('drain', resolve))",
  '    }',
  '  }',
  `  if (!process.stdout.write(${JSON.stringify(E2B_OUTPUT_COMPLETE_FRAME)} + '\\n')) {`,
  "    await new Promise(resolve => process.stdout.once('drain', resolve))",
  '  }',
  '})().catch(() => { process.exitCode = 1 })',
].join('\n')

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

function hasSpill(mode: SubprocessOutputMode): mode is SubprocessCollect & { spill: { maxBytes: number } } {
  return isCollect(mode) && mode.spill !== undefined
}

function isValidProcessId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

class DeferredStdin extends Writable {
  constructor(private readonly ready: Promise<CommandHandle>) {
    super({ decodeStrings: false })
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.ready.then(handle => handle.sendStdin(chunk)).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.ready.then(handle => handle.closeStdin()).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }
}

interface RemotePaths {
  pid: string
  status: string
  environment: string
  stdout: string
  stderr: string
}

type CommandSettlement =
  | { kind: 'result'; result: CommandResult }
  | { kind: 'error'; error: unknown }

function withinMs<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
    void promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

function commandText(spec: SubprocessSpawnSpec, paths: RemotePaths): string {
  const encoder = `"$dsh_e2b_env_bin" -i "$dsh_e2b_node" -e ${quoteE2BShellArg(OUTPUT_ENCODER_SOURCE)}`
  const stdoutRedirect = hasSpill(spec.stdio.stdout)
    ? `> >("$dsh_e2b_tee" --output-error=warn-nopipe >("$dsh_e2b_head" -c ${spec.stdio.stdout.spill.maxBytes} > ${quoteE2BShellArg(paths.stdout)}) | ${encoder} 2>/dev/null)`
    : `> >(${encoder} 2>/dev/null)`
  const stderrRedirect = hasSpill(spec.stdio.stderr)
    ? `2> >("$dsh_e2b_tee" --output-error=warn-nopipe >("$dsh_e2b_head" -c ${spec.stdio.stderr.spill.maxBytes} > ${quoteE2BShellArg(paths.stderr)}) | ${encoder} >&2 2>/dev/null)`
    : `2> >(${encoder} >&2 2>/dev/null)`
  const inner = [
    'set +e',
    'umask 077',
    'dsh_e2b_env_bin=$1',
    'dsh_e2b_node=$2',
    'dsh_e2b_ps=$3',
    'dsh_e2b_tr=$4',
    'dsh_e2b_tee=$5',
    'dsh_e2b_head=$6',
    'dsh_e2b_rm=$7',
    'shift 7',
    'dsh_e2b_pgid="$("$dsh_e2b_ps" -o pgid= -p "$$" | "$dsh_e2b_tr" -d " ")"',
    `printf '%s\\n' "$dsh_e2b_pgid" > ${quoteE2BShellArg(paths.pid)}`,
    `mapfile -d '' -t dsh_e2b_env < ${quoteE2BShellArg(paths.environment)}`,
    `"$dsh_e2b_rm" -f -- ${quoteE2BShellArg(paths.environment)}`,
    `"$dsh_e2b_env_bin" -i -- "\${dsh_e2b_env[@]}" "$@" ${stdoutRedirect} ${stderrRedirect}`.trimEnd(),
    'dsh_e2b_status=$?',
    `printf '%s\\n' "$dsh_e2b_status" > ${quoteE2BShellArg(paths.status)}`,
    'wait',
    'exit "$dsh_e2b_status"',
  ].join('\n')
  const argv = spec.argv.map(quoteE2BShellArg).join(' ')
  const bootstrap = [
    `mapfile -d '' -t dsh_e2b_env < ${quoteE2BShellArg(paths.environment)}`,
    'dsh_e2b_env_bin="$(command -v env)"',
    'dsh_e2b_setsid="$(command -v setsid)"',
    'dsh_e2b_bash="$(command -v bash)"',
    'dsh_e2b_node="$(command -v node)"',
    'dsh_e2b_ps="$(command -v ps)"',
    'dsh_e2b_tr="$(command -v tr)"',
    'dsh_e2b_tee="$(command -v tee)"',
    'dsh_e2b_head="$(command -v head)"',
    'dsh_e2b_rm="$(command -v rm)"',
    'for dsh_e2b_tool in "$dsh_e2b_env_bin" "$dsh_e2b_setsid" "$dsh_e2b_bash" "$dsh_e2b_node" "$dsh_e2b_ps" "$dsh_e2b_tr" "$dsh_e2b_tee" "$dsh_e2b_head" "$dsh_e2b_rm"; do',
    '  [[ "$dsh_e2b_tool" == /* && -x "$dsh_e2b_tool" ]] || exit 125',
    'done',
    `exec "$dsh_e2b_env_bin" -i -- "\${dsh_e2b_env[@]}" "$dsh_e2b_setsid" --wait -- "$dsh_e2b_bash" -c ${quoteE2BShellArg(inner)} dsh-e2b "$dsh_e2b_env_bin" "$dsh_e2b_node" "$dsh_e2b_ps" "$dsh_e2b_tr" "$dsh_e2b_tee" "$dsh_e2b_head" "$dsh_e2b_rm" ${argv}`,
  ].join('\n')
  return bootstrap
}

function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function waitTick(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, GROUP_POLL_MS)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const WAIT_ABORTED = Symbol('wait aborted')

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof WAIT_ABORTED> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(WAIT_ABORTED)
  return new Promise<T | typeof WAIT_ABORTED>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); resolve(WAIT_ABORTED) }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void promise.then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(asError(error)) },
    )
  })
}

/** E2B-backed subprocess handle with deferred remote PID acquisition. */
export class E2BSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly commandState = Promise.withResolvers<CommandHandle | undefined>()
  private readonly readyState = Promise.withResolvers<CommandHandle>()
  private readonly stdoutDecoder = new E2BBase64Decoder()
  private readonly stderrDecoder = new E2BBase64Decoder()
  private readonly outputTermination = new AbortController()
  private readonly startupController = new AbortController()
  private readonly stdoutReader: E2BOutputReader | undefined
  private readonly stderrReader: E2BOutputReader | undefined
  private readonly paths: RemotePaths
  private remotePid = -1
  private commandHandle: CommandHandle | undefined
  private outputTransportError: Error | undefined
  private outputDrainExpired = false
  private stateDirectoryCreated = false
  private preparing = true
  private invalidHandleQuiescent = false
  private provisionalHandleQuiescent = false
  private terminationStarted = false
  private terminationFenced = false
  private quiescenceProven = false
  private terminationAttempt: Promise<void> | undefined
  private terminationFailure: Error | undefined
  private terminationSignal: NodeJS.Signals | null = null

  /**
   * Begin an E2B command without blocking the synchronous subprocess spawn seam.
   * @param runtime - Shared E2B sandbox owner.
   * @param spec - Fully resolved subprocess request.
   * @param stateDir - Remote directory retaining process identity, status, and valid spills.
   */
  constructor(
    private readonly runtime: E2BSandboxService,
    private readonly spec: SubprocessSpawnSpec,
    readonly stateDir: string,
  ) {
    this.paths = {
      pid: posix.join(stateDir, 'pid'),
      status: posix.join(stateDir, 'exit-code'),
      environment: posix.join(stateDir, 'environment'),
      stdout: posix.join(stateDir, 'stdout.log'),
      stderr: posix.join(stateDir, 'stderr.log'),
    }
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    this.stdoutReader = isCollect(outMode)
      ? new E2BOutputReader(outMode.maxBytes, outMode.spill?.maxBytes, this.paths.stdout)
      : undefined
    this.stderrReader = isCollect(errMode)
      ? new E2BOutputReader(errMode.maxBytes, errMode.spill?.maxBytes, this.paths.stderr)
      : undefined
    this.collected = {
      ...(this.stdoutReader !== undefined ? { stdout: this.stdoutReader } : {}),
      ...(this.stderrReader !== undefined ? { stderr: this.stderrReader } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe' ? new DeferredStdin(this.readyState.promise) : undefined
    void this.readyState.promise.catch(() => {})
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.done = this.run()
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** Remote process id after start; `-1` while E2B startup is pending or after it fails. */
  get pid(): number {
    return this.remotePid
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.terminationFenced || this.quiescenceProven || this.terminationAttempt !== undefined) return
    this.terminationStarted = true
    if (this.preparing) this.startupController.abort(new Error('subprocess-e2b: command terminated during startup'))
    this.outputTermination.abort()
    this.stdout?.destroy()
    this.stderr?.destroy()
    this.terminationFailure = undefined
    const attempt = this.terminateRemote()
    this.terminationAttempt = attempt
    void attempt.then(
      () => {
        this.terminationFenced = true
        this.terminationAttempt = undefined
      },
      (error: unknown) => {
        if (!this.quiescenceProven) this.terminationFailure = asError(error)
        this.terminationAttempt = undefined
      },
    )
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.quiescenceProven) return true
    let handle: CommandHandle | undefined
    if (this.terminationStarted) {
      const observed = await waitWithSignal(this.commandState.promise, signal)
      if (observed === WAIT_ABORTED) return false
      handle = observed
      if (handle === undefined) {
        this.markQuiescent()
        return true
      }
      if (this.remotePid <= 0) {
        const attempt = this.terminationAttempt
        if (attempt !== undefined && await waitWithSignal(attempt, signal) === WAIT_ABORTED) return false
        this.throwTerminationFailure()
        /* v8 ignore else -- successful provisional cleanup always records one proof; failures throw above. */
        if (this.invalidHandleQuiescent || this.provisionalHandleQuiescent) {
          this.markQuiescent()
          return true
        }
      }
    } else {
      try {
        const observed = await waitWithSignal(this.readyState.promise, signal)
        if (observed === WAIT_ABORTED) return false
        handle = observed
      } catch {
        handle = this.commandHandle
        if (handle === undefined) {
          this.markQuiescent()
          return true
        }
      }
    }
    this.throwTerminationFailure()
    let sandbox: Sandbox
    try {
      sandbox = await this.runtime.getSandbox()
    } catch (error: unknown) {
      if (isAborted(signal)) return false
      if (error instanceof SandboxNotFoundError) {
        this.markQuiescent()
        return true
      }
      throw error
    }
    const processGroupId = this.remotePid > 0 ? this.remotePid : handle.pid
    while (await this.groupAlive(sandbox, processGroupId, signal)) {
      this.throwTerminationFailure()
      if (!await waitTick(signal)) return false
    }
    this.throwTerminationFailure()
    if (isAborted(signal)) return false
    this.markQuiescent()
    return true
  }

  private readonly onAbort = (): void => { this.terminate() }

  private markQuiescent(): void {
    this.quiescenceProven = true
    this.terminationFailure = undefined
  }

  private async run(): Promise<SubprocessOutcome> {
    let sandbox: Sandbox | undefined
    try {
      sandbox = await this.runtime.getSandbox()
      await this.prepareState(sandbox)
      this.preparing = false
      const handle = await sandbox.commands.run(
        commandText(this.spec, this.paths),
        {
          background: true,
          cwd: this.spec.cwd,
          stdin: this.spec.stdio.stdin !== 'ignore',
          timeoutMs: 0,
          onStdout: async (data) => { await this.dispatchOutput('stdout', data) },
          onStderr: async (data) => { await this.dispatchOutput('stderr', data) },
        },
      )
      this.commandHandle = handle
      const completion = handle.wait()
      void completion.catch(() => {})
      if (!isValidProcessId(handle.pid)) {
        const invalidPid = new Error(`subprocess-e2b: E2B returned invalid command pid ${handle.pid}`)
        try {
          await handle.kill()
          this.invalidHandleQuiescent = true
          this.commandHandle = undefined
        } catch (cleanupError: unknown) {
          this.terminationFailure = asError(cleanupError)
          this.commandState.resolve(handle)
          throw new AggregateError(
            [invalidPid, cleanupError],
            'subprocess-e2b: invalid command pid rollback did not reach quiescence',
          )
        }
        throw invalidPid
      }
      this.commandState.resolve(handle)
      try {
        this.remotePid = await this.waitForProcessGroupId(sandbox, completion)
      } catch (error: unknown) {
        try {
          await this.rollbackUnpublishedGroup(sandbox, handle)
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'subprocess-e2b: process-group publication failed and rollback did not reach quiescence',
          )
        }
        throw error
      }
      this.readyState.resolve(handle)
      await this.writeBatchStdin(handle)
      const outcome = await this.waitForCommand(sandbox, handle, completion)
      if (this.outputTransportError !== undefined) throw this.outputTransportError
      const requireCompleteOutput = this.terminationSignal === null && !this.outputDrainExpired
      this.stdoutDecoder.finish(requireCompleteOutput)
      this.stderrDecoder.finish(requireCompleteOutput)
      await this.finalizeSpills(sandbox)
      return outcome
    } catch (error: unknown) {
      const canceledPreparation = this.preparing
        && this.terminationStarted
        && this.startupController.signal.aborted
      let failure = await this.rollbackPublishedFailure(error)
      if (sandbox !== undefined && this.stateDirectoryCreated) {
        try {
          await this.removeFailedState(sandbox)
        } catch (cleanupError: unknown) {
          failure = new AggregateError(
            [error, cleanupError],
            'subprocess-e2b: command failed and private state cleanup failed',
          )
        }
      }
      this.commandState.resolve(undefined)
      this.readyState.reject(failure)
      if (canceledPreparation && failure === error) return { exitCode: null, signal: 'SIGTERM' }
      throw failure
    } finally {
      this.preparing = false
      this.spec.signal?.removeEventListener('abort', this.onAbort)
      this.stdout?.end()
      this.stderr?.end()
    }
  }

  private async prepareState(sandbox: Sandbox): Promise<void> {
    const signal = this.startupController.signal
    const ambient = await readRemoteEnvironment(sandbox, signal)
    await sandbox.files.makeDir(this.stateDir, { signal })
    this.stateDirectoryCreated = true
    await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(this.stateDir)}`, { signal })
    const files = [
      { path: this.paths.pid, data: '' },
      { path: this.paths.status, data: '' },
      { path: this.paths.environment, data: serializeRemoteEnvironment(ambient, this.spec.env) },
      ...(hasSpill(this.spec.stdio.stdout) ? [{ path: this.paths.stdout, data: '' }] : []),
      ...(hasSpill(this.spec.stdio.stderr) ? [{ path: this.paths.stderr, data: '' }] : []),
    ]
    await sandbox.files.write(files, { signal })
    await sandbox.commands.run(`chmod 600 -- ${files.map(file => quoteE2BShellArg(file.path)).join(' ')}`, { signal })
    signal.throwIfAborted()
  }

  private async writeBatchStdin(handle: CommandHandle): Promise<void> {
    if (typeof this.spec.stdio.stdin !== 'object') return
    try {
      await handle.sendStdin(this.spec.stdio.stdin.data)
      await handle.closeStdin()
    } catch (_processClosedItsInput) {
      // Like the local adapter, batch stdin is best-effort; exit and output remain authoritative.
    }
  }

  private async dispatchOutput(stream: 'stdout' | 'stderr', data: string): Promise<void> {
    let bytes: Buffer
    try {
      bytes = stream === 'stdout' ? this.stdoutDecoder.push(data) : this.stderrDecoder.push(data)
    } catch (error: unknown) {
      this.outputTransportError ??= asError(error)
      const target = stream === 'stdout' ? this.stdout : this.stderr
      target?.destroy(this.outputTransportError)
      return
    }
    try {
      if (stream === 'stdout') {
        this.stdoutReader?.push(bytes)
        await this.writeOutput(this.stdout, this.spec.stdio.stdout === 'inherit' ? process.stdout : undefined, bytes)
        return
      }
      this.stderrReader?.push(bytes)
      await this.writeOutput(this.stderr, this.spec.stdio.stderr === 'inherit' ? process.stderr : undefined, bytes)
    } catch (error: unknown) {
      const target = stream === 'stdout' ? this.stdout : this.stderr
      target?.destroy(asError(error))
    }
  }

  private async writeOutput(pipe: PassThrough | undefined, inherited: NodeJS.WriteStream | undefined, data: Uint8Array): Promise<void> {
    const target = pipe ?? inherited
    if (target === undefined || data.length === 0 || this.outputTermination.signal.aborted) return
    if (target.destroyed) throw new Error('subprocess output stream is closed')
    if (target.write(data)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve() }
      const onClose = (): void => { cleanup(); resolve() }
      const onTermination = (): void => { cleanup(); resolve() }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const cleanup = (): void => {
        target.removeListener('drain', onDrain)
        target.removeListener('close', onClose)
        target.removeListener('error', onError)
        this.outputTermination.signal.removeEventListener('abort', onTermination)
      }
      target.once('drain', onDrain)
      target.once('close', onClose)
      target.once('error', onError)
      this.outputTermination.signal.addEventListener('abort', onTermination, { once: true })
      if (this.outputTermination.signal.aborted) onTermination()
    })
  }

  private async waitForProcessGroupId(sandbox: Sandbox, completion: Promise<CommandResult>): Promise<number> {
    const commandSettled = completion.then(
      () => true,
      () => true,
    )
    while (true) {
      const raw = await sandbox.files.read(this.paths.pid)
      const value = raw.trim()
      if (value.length > 0) {
        const pid = Number(value)
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pid)) {
          throw new Error(`subprocess-e2b: remote wrapper published invalid process-group id ${JSON.stringify(value)}`)
        }
        return pid
      }
      const settled = await Promise.race([commandSettled, waitTick().then(() => false)])
      if (settled) throw new Error('subprocess-e2b: remote command exited before publishing its process-group id')
    }
  }

  private async waitForCommand(
    sandbox: Sandbox,
    handle: CommandHandle,
    completion: Promise<CommandResult>,
  ): Promise<SubprocessOutcome> {
    const settlement = completion.then<CommandSettlement, CommandSettlement>(
      result => ({ kind: 'result', result }),
      (error: unknown) => ({ kind: 'error', error }),
    )
    while (true) {
      const rawStatus = (await sandbox.files.read(this.paths.status)).trim()
      if (rawStatus.length > 0) {
        const exitCode = Number(rawStatus)
        if (!/^(?:0|[1-9][0-9]*)$/.test(rawStatus) || !Number.isSafeInteger(exitCode) || exitCode > 255) {
          throw new Error(`subprocess-e2b: remote wrapper published invalid exit code ${JSON.stringify(rawStatus)}`)
        }
        if (this.spec.stdio.stdout === 'pipe' || this.spec.stdio.stderr === 'pipe') {
          return this.commandOutcome(await settlement, exitCode)
        }
        const completed = await withinMs(settlement, this.spec.graceMs)
        if (completed !== undefined) return this.commandOutcome(completed, exitCode)
        this.outputDrainExpired = true
        this.stdoutReader?.invalidateSpill()
        this.stderrReader?.invalidateSpill()
        await handle.disconnect()
        return { exitCode, signal: null }
      }
      const completed = await Promise.race([settlement, waitTick().then(() => undefined)])
      if (completed !== undefined) return this.commandOutcome(completed)
    }
  }

  private commandOutcome(settlement: CommandSettlement, publishedExitCode?: number): SubprocessOutcome {
    if (settlement.kind === 'result') {
      return { exitCode: publishedExitCode ?? settlement.result.exitCode, signal: null }
    }
    if (settlement.error instanceof CommandExitError) {
      if (publishedExitCode !== undefined) return { exitCode: publishedExitCode, signal: null }
      return this.terminationSignal === null
        ? { exitCode: settlement.error.exitCode, signal: null }
        : { exitCode: null, signal: this.terminationSignal }
    }
    throw settlement.error
  }

  private async rollbackPublishedFailure(error: unknown): Promise<unknown> {
    if (this.remotePid <= 0 || this.commandHandle === undefined || this.quiescenceProven) return error
    this.terminate()
    try {
      await this.waitForExit()
      return error
    } catch (cleanupError: unknown) {
      return new AggregateError(
        [asError(error), asError(cleanupError)],
        'subprocess-e2b: command monitoring failed and process-group rollback did not reach quiescence',
      )
    }
  }

  private async rollbackUnpublishedGroup(sandbox: Sandbox, handle: CommandHandle): Promise<void> {
    // The bootstrap ends in an exec chain through the scrubbed environment and
    // `setsid`, so E2B's command PID is the provisional group id even before the
    // private publication file can be trusted. Kill that group before the SDK-PID
    // fallback, then prove no group member survived before rejecting startup.
    try {
      await this.signalGroup(sandbox, handle.pid, 'KILL')
    } finally {
      await handle.kill().catch(() => false)
    }
    while (await this.groupAlive(sandbox, handle.pid)) await waitTick()
  }

  private async terminateRemote(): Promise<void> {
    try {
      await this.terminateRemoteInSandbox()
    } catch (error: unknown) {
      if (error instanceof SandboxNotFoundError) {
        this.markQuiescent()
        return
      }
      throw error
    }
  }

  private async terminateRemoteInSandbox(): Promise<void> {
    const handle = await this.commandState.promise
    if (handle === undefined) return
    if (!isValidProcessId(handle.pid) && this.remotePid <= 0) {
      await handle.kill()
      this.invalidHandleQuiescent = true
      this.commandHandle = undefined
      return
    }
    if (this.remotePid <= 0) {
      const sandbox = await this.runtime.getSandbox()
      this.terminationSignal = 'SIGTERM'
      try {
        const delivered = await this.signalGroup(sandbox, handle.pid, 'TERM')
        if (delivered) {
          const deadline = Date.now() + this.spec.graceMs
          while (Date.now() < deadline && await this.groupAlive(sandbox, handle.pid)) await waitTick()
          if (!await this.groupAlive(sandbox, handle.pid)) {
            this.provisionalHandleQuiescent = true
            return
          }
        }
      } catch (_gracefulTerminationFailure) {
        // A missing or unobservable provisional group still has the SDK handle fallback.
      }
      this.terminationSignal = 'SIGKILL'
      let groupDelivered = false
      let groupFailure: unknown
      try {
        groupDelivered = await this.signalGroup(sandbox, handle.pid, 'KILL')
      } catch (error: unknown) {
        groupFailure = error
      }
      let handleFailure: unknown
      try {
        if (!await handle.kill()) handleFailure = new Error('E2B SDK kill did not report command termination')
      } catch (error: unknown) {
        handleFailure = error
      }
      if (!groupDelivered && await this.groupAlive(sandbox, handle.pid)) {
        throw new AggregateError(
          [
            ...(groupFailure === undefined ? [] : [groupFailure]),
            ...(handleFailure === undefined
              ? [new Error('E2B SDK kill did not quiesce the provisional process group')]
              : [handleFailure]),
          ],
          'subprocess-e2b: force termination failed through both process-group and SDK transports',
        )
      }
      while (await this.groupAlive(sandbox, handle.pid)) await waitTick()
      this.provisionalHandleQuiescent = true
      return
    }
    const sandbox = await this.runtime.getSandbox()
    const processGroupId = this.remotePid
    this.terminationSignal = 'SIGTERM'
    try {
      await this.signalGroup(sandbox, processGroupId, 'TERM')
      const deadline = Date.now() + this.spec.graceMs
      while (Date.now() < deadline && await this.groupAlive(sandbox, processGroupId)) {
        await waitTick()
      }
      if (!await this.groupAlive(sandbox, processGroupId)) return
    } catch (_gracefulTerminationFailure) {
      // Failed TERM delivery or observation cannot prove exit; force cleanup still owns the group.
    }
    this.terminationSignal = 'SIGKILL'
    let groupFailure: unknown
    let groupDelivered = false
    try {
      groupDelivered = await this.signalGroup(sandbox, processGroupId, 'KILL')
    } catch (error: unknown) {
      groupFailure = error
    }
    let handleFailure: unknown
    try {
      await handle.kill()
    } catch (error: unknown) {
      handleFailure = error
    }
    if (!groupDelivered && handleFailure !== undefined && await this.groupAlive(sandbox, processGroupId)) {
      throw new AggregateError(
        [...(groupFailure === undefined ? [] : [groupFailure]), handleFailure],
        'subprocess-e2b: force termination failed through both process-group and SDK transports',
      )
    }
  }

  private throwTerminationFailure(): void {
    if (this.terminationFailure !== undefined) throw this.terminationFailure
  }

  private async signalGroup(sandbox: Sandbox, pid: number, signal: 'TERM' | 'KILL'): Promise<boolean> {
    try {
      await sandbox.commands.run(`kill -${signal} -- -${pid}`)
      return true
    } catch (error: unknown) {
      if (error instanceof CommandExitError || error instanceof SandboxNotFoundError) return false
      throw error
    }
  }

  private async groupAlive(sandbox: Sandbox, pid: number, signal?: AbortSignal): Promise<boolean> {
    const result = await sandbox.commands.run(
      `set -o pipefail; ps -eo pgid=,stat= | awk '$1 == ${pid} && $2 !~ /^[ZXx]/ { live=1 } END { if (live) print "live" }'`,
      signalOpts(signal),
    ).catch((error: unknown) => {
      if (signal?.aborted === true) return undefined
      if (error instanceof SandboxNotFoundError) return { exitCode: 0, stdout: '', stderr: '' }
      throw error
    })
    return result?.stdout.trim() === 'live'
  }

  private async finalizeSpills(sandbox: Sandbox): Promise<void> {
    const removals: Promise<void>[] = []
    const collect = (mode: SubprocessOutputMode, reader: E2BOutputReader | undefined, path: string): void => {
      if (!hasSpill(mode)) return
      // A spill mode is a collect mode, so construction always created its reader.
      const size = (reader as E2BOutputReader).size
      if (this.outputDrainExpired || size <= mode.maxBytes || size > mode.spill.maxBytes) {
        removals.push(sandbox.files.remove(path).catch(() => {}))
      }
    }
    collect(this.spec.stdio.stdout, this.stdoutReader, this.paths.stdout)
    collect(this.spec.stdio.stderr, this.stderrReader, this.paths.stderr)
    await Promise.all(removals)
  }

  private async removeFailedState(sandbox: Sandbox): Promise<void> {
    const failures: Error[] = []
    for (const path of [this.paths.environment, this.stateDir]) {
      try {
        await sandbox.files.remove(path)
      } catch (error: unknown) {
        if (!(error instanceof FileNotFoundError)) failures.push(asError(error))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'subprocess-e2b: failed to remove private command state')
    }
  }
}
