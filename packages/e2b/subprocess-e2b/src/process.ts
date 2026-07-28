/** One asynchronously-started E2B command projected onto the subprocess seam. */

import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'
import { posix } from 'node:path'
import {
  CommandExitError,
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
import { E2BOutputReader } from './output.ts'

const GROUP_POLL_MS = 20

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

function hasSpill(mode: SubprocessOutputMode): mode is SubprocessCollect & { spill: { maxBytes: number } } {
  return isCollect(mode) && mode.spill !== undefined
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

function explicitEnvironment(env: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(env ?? {})
    .map(([name, value]) => `${name}=${value}\0`)
    .join('')
}

function commandText(spec: SubprocessSpawnSpec, paths: RemotePaths): string {
  const stdoutRedirect = hasSpill(spec.stdio.stdout)
    ? `> >(tee --output-error=warn-nopipe >(head -c ${spec.stdio.stdout.spill.maxBytes} > ${quoteE2BShellArg(paths.stdout)}))`
    : ''
  const stderrRedirect = hasSpill(spec.stdio.stderr)
    ? `2> >(tee --output-error=warn-nopipe >(head -c ${spec.stdio.stderr.spill.maxBytes} > ${quoteE2BShellArg(paths.stderr)}) >&2)`
    : ''
  const inner = [
    'set +e',
    'umask 077',
    'dsh_e2b_pgid="$(ps -o pgid= -p "$$" | tr -d " ")"',
    `printf '%s\\n' "$dsh_e2b_pgid" > ${quoteE2BShellArg(paths.pid)}`,
    `mapfile -d '' -t dsh_e2b_explicit < ${quoteE2BShellArg(paths.environment)}`,
    `: > ${quoteE2BShellArg(paths.environment)}`,
    'dsh_e2b_env=()',
    "while IFS= read -r -d '' dsh_e2b_entry; do",
    '  dsh_e2b_name="${dsh_e2b_entry%%=*}"',
    '  case "${dsh_e2b_name^^}" in DSH_*|*KEY*|*SECRET*|*TOKEN*) continue ;; esac',
    '  dsh_e2b_env+=("$dsh_e2b_entry")',
    'done < <(env -0)',
    `env -i "\${dsh_e2b_env[@]}" "\${dsh_e2b_explicit[@]}" "$@" ${stdoutRedirect} ${stderrRedirect}`.trimEnd(),
    'dsh_e2b_status=$?',
    'wait',
    `printf '%s\\n' "$dsh_e2b_status" > ${quoteE2BShellArg(paths.status)}`,
    'exit "$dsh_e2b_status"',
  ].join('\n')
  const argv = spec.argv.map(quoteE2BShellArg).join(' ')
  return `exec setsid --wait -- bash -c ${quoteE2BShellArg(inner)} dsh-e2b ${argv}`
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

/** E2B-backed subprocess handle with deferred remote PID acquisition. */
export class E2BSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly readyState = Promise.withResolvers<CommandHandle>()
  private readonly stdoutReader: E2BOutputReader | undefined
  private readonly stderrReader: E2BOutputReader | undefined
  private readonly paths: RemotePaths
  private remotePid = -1
  private terminationRequested = false
  private terminationSignal: NodeJS.Signals | null = null
  private termination: Promise<void> | undefined

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
    if (this.terminationRequested) return
    this.terminationRequested = true
    this.termination = this.terminateRemote()
    void this.termination.catch(() => {})
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    let handle: CommandHandle | undefined
    try {
      handle = await this.readyForWait(signal)
    } catch {
      return true
    }
    if (handle === undefined) return false
    let sandbox: Sandbox
    try {
      sandbox = await this.runtime.getSandbox()
    } catch (error: unknown) {
      if (isAborted(signal)) return false
      throw error
    }
    while (await this.groupAlive(sandbox, this.remotePid, signal)) {
      if (!await waitTick(signal)) return false
    }
    return !isAborted(signal)
  }

  private readyForWait(signal: AbortSignal | undefined): Promise<CommandHandle | undefined> {
    if (signal === undefined) return this.readyState.promise
    return new Promise<CommandHandle | undefined>((resolve, reject) => {
      const onAbort = (): void => { cleanup(); resolve(undefined) }
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      void this.readyState.promise.then(
        (handle) => { cleanup(); resolve(handle) },
        (error: unknown) => { cleanup(); reject(asError(error)) },
      )
    })
  }

  private readonly onAbort = (): void => { this.terminate() }

  private async run(): Promise<SubprocessOutcome> {
    try {
      const sandbox = await this.runtime.getSandbox()
      await this.prepareState(sandbox)
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
      if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) {
        throw new Error(`subprocess-e2b: E2B returned invalid command pid ${handle.pid}`)
      }
      const completion = handle.wait()
      void completion.catch(() => {})
      try {
        this.remotePid = await this.waitForProcessGroupId(sandbox, completion)
      } catch (error: unknown) {
        await Promise.allSettled([handle.kill()])
        throw error
      }
      this.readyState.resolve(handle)
      await this.writeBatchStdin(handle)
      const outcome = await this.waitForCommand(completion)
      await this.finalizeSpills(sandbox)
      return outcome
    } catch (error: unknown) {
      this.readyState.reject(error)
      throw error
    } finally {
      this.spec.signal?.removeEventListener('abort', this.onAbort)
      this.stdout?.end()
      this.stderr?.end()
    }
  }

  private async prepareState(sandbox: Sandbox): Promise<void> {
    await sandbox.files.makeDir(this.stateDir)
    await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(this.stateDir)}`)
    const files = [
      { path: this.paths.pid, data: '' },
      { path: this.paths.status, data: '' },
      { path: this.paths.environment, data: explicitEnvironment(this.spec.env) },
      ...(hasSpill(this.spec.stdio.stdout) ? [{ path: this.paths.stdout, data: '' }] : []),
      ...(hasSpill(this.spec.stdio.stderr) ? [{ path: this.paths.stderr, data: '' }] : []),
    ]
    await sandbox.files.write(files)
    await sandbox.commands.run(`chmod 600 -- ${files.map(file => quoteE2BShellArg(file.path)).join(' ')}`)
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
    try {
      if (stream === 'stdout') {
        this.stdoutReader?.push(data)
        await this.writeOutput(this.stdout, this.spec.stdio.stdout === 'inherit' ? process.stdout : undefined, data)
        return
      }
      this.stderrReader?.push(data)
      await this.writeOutput(this.stderr, this.spec.stdio.stderr === 'inherit' ? process.stderr : undefined, data)
    } catch (error: unknown) {
      const target = stream === 'stdout' ? this.stdout : this.stderr
      target?.destroy(asError(error))
    }
  }

  private async writeOutput(pipe: PassThrough | undefined, inherited: NodeJS.WriteStream | undefined, data: string): Promise<void> {
    const target = pipe ?? inherited
    if (target === undefined || data.length === 0) return
    if (target.destroyed) throw new Error('subprocess output stream is closed')
    if (target.write(Buffer.from(data))) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve() }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const cleanup = (): void => {
        target.removeListener('drain', onDrain)
        target.removeListener('error', onError)
      }
      target.once('drain', onDrain)
      target.once('error', onError)
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

  private async waitForCommand(completion: Promise<CommandResult>): Promise<SubprocessOutcome> {
    try {
      const result = await completion
      return { exitCode: result.exitCode, signal: null }
    } catch (error: unknown) {
      if (error instanceof CommandExitError) {
        return this.terminationSignal === null
          ? { exitCode: error.exitCode, signal: null }
          : { exitCode: null, signal: this.terminationSignal }
      }
      throw error
    }
  }

  private async terminateRemote(): Promise<void> {
    let handle: CommandHandle
    try {
      handle = await this.readyState.promise
    } catch {
      return
    }
    const sandbox = await this.runtime.getSandbox()
    this.terminationSignal = 'SIGTERM'
    await this.signalGroup(sandbox, this.remotePid, 'TERM')
    const deadline = Date.now() + this.spec.graceMs
    while (Date.now() < deadline && await this.groupAlive(sandbox, this.remotePid)) {
      await waitTick()
    }
    if (!await this.groupAlive(sandbox, this.remotePid)) return
    this.terminationSignal = 'SIGKILL'
    try {
      await this.signalGroup(sandbox, this.remotePid, 'KILL')
    } finally {
      await handle.kill().catch(() => false)
    }
  }

  private async signalGroup(sandbox: Sandbox, pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    try {
      await sandbox.commands.run(`kill -${signal} -- -${pid}`)
    } catch (error: unknown) {
      if (!(error instanceof CommandExitError)) throw error
    }
  }

  private async groupAlive(sandbox: Sandbox, pid: number, signal?: AbortSignal): Promise<boolean> {
    try {
      await sandbox.commands.run(`kill -0 -- -${pid}`, signalOpts(signal))
      return true
    } catch (error: unknown) {
      if (signal?.aborted === true) return false
      if (error instanceof CommandExitError) return false
      throw error
    }
  }

  private async finalizeSpills(sandbox: Sandbox): Promise<void> {
    const removals: Promise<void>[] = []
    const collect = (mode: SubprocessOutputMode, reader: E2BOutputReader | undefined, path: string): void => {
      if (!hasSpill(mode)) return
      // A spill mode is a collect mode, so construction always created its reader.
      const size = (reader as E2BOutputReader).size
      if (size <= mode.maxBytes || size > mode.spill.maxBytes) {
        removals.push(sandbox.files.remove(path).catch(() => {}))
      }
    }
    collect(this.spec.stdio.stdout, this.stdoutReader, this.paths.stdout)
    collect(this.spec.stdio.stderr, this.stderrReader, this.paths.stderr)
    await Promise.all(removals)
  }
}
