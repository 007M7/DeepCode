/**
 * Shared ownership of one E2B sandbox. Capability adapters await the same SDK
 * handle, so filesystem and process operations inhabit one remote Linux world.
 * @module @deepseek-ai/dsh-e2b
 */

import { posix } from 'node:path'
import { Context, Service } from 'cordis'
import z from 'schemastery'
import { FileType, Sandbox, SandboxNotFoundError } from 'e2b'
import type { Branded } from '@deepseek-ai/dsh-brand'

export {
  CommandExitError,
  FileNotFoundError,
  FileType,
  Sandbox,
  SandboxError,
  SandboxNotFoundError,
  TimeoutError,
} from 'e2b'
export type { CommandHandle, CommandResult, EntryInfo, ProcessInfo, PtyOutput } from 'e2b'

/** Opaque E2B sandbox identity used for reconnecting a later harness process. */
export type E2BSandboxId = Branded<'E2BSandboxId'>

/**
 * Brand an SDK sandbox id after E2B has created or resolved it.
 * @param value - E2B's opaque sandbox id.
 * @returns the same string with the harness brand.
 */
export function E2BSandboxId(value: string): E2BSandboxId {
  return value as E2BSandboxId
}

/**
 * Quote one opaque argument for the SDK's unavoidable `/bin/bash -l -c` layer.
 * @param value - Exact argument value to preserve.
 * @returns A single shell word with no interpolation.
 */
export function quoteE2BShellArg(value: string): string {
  return `'${value.replaceAll('\'', "'\"'\"'")}'`
}

/** Action taken on the owned sandbox when the Cordis service is disposed. */
export type E2BDisposeMode = 'kill' | 'pause' | 'leave'

/** Action E2B takes when a newly created sandbox reaches its lifetime. */
export type E2BTimeoutMode = 'kill' | 'pause'

/** Configuration for the shared E2B sandbox owner. */
export interface Config {
  /** API key; omission reads `E2B_API_KEY`. It is never forwarded into the sandbox. */
  apiKey?: string
  /** Existing sandbox to reconnect instead of creating a new one. */
  sandboxId?: string
  /** Template name or id for a newly created sandbox. */
  template?: string
  /** Shared remote working directory, created before adapters receive the sandbox. */
  cwd?: string
  /** E2B sandbox lifetime in milliseconds. */
  timeoutMs?: number
  /** E2B action when a newly created sandbox reaches `timeoutMs`. */
  onTimeout?: E2BTimeoutMode
  /** Disposal policy; `pause` and `leave` retain remote state for reconnect. */
  onDispose?: E2BDisposeMode
}

interface ResolvedConfig {
  apiKey: string
  cwd: string
  timeoutMs: number
  onTimeout: E2BTimeoutMode
  onDispose: E2BDisposeMode
  sandboxId?: string
  template?: string
}

interface SchemaResolvedConfig extends Config {
  cwd: string
  timeoutMs: number
  onTimeout: E2BTimeoutMode
  onDispose: E2BDisposeMode
}

declare module 'cordis' {
  interface Context {
    e2b: E2BSandboxService
  }
}

/**
 * Owns one lazily consumable E2B SDK handle and its final kill/pause/leave
 * decision. The connection begins at plugin construction; adapters await
 * {@link getSandbox} before their first operation.
 */
export class E2BSandboxService extends Service {
  static Config: z<Config> = z.object({
    apiKey: z.string(),
    sandboxId: z.string(),
    template: z.string(),
    cwd: z.string().default('/home/user/workspace'),
    timeoutMs: z.number().default(300_000),
    onTimeout: z.union(['kill', 'pause'] as const).default('pause'),
    onDispose: z.union(['kill', 'pause', 'leave'] as const).default('kill'),
  })

  /** Validated remote working directory shared by provider adapters. */
  readonly cwd: string
  /** Remote directory reserved for adapter-owned process and terminal state. */
  readonly runtimeRoot: string
  /** Whether this service creates a sandbox rather than reconnecting one. */
  readonly created: boolean
  /** Configured action when a newly created sandbox reaches its lifetime. */
  readonly timeoutMode: E2BTimeoutMode
  /** Configured final sandbox disposition. */
  readonly disposeMode: E2BDisposeMode
  /** Sandbox id once E2B has created or resolved the remote runtime. */
  readonly sandboxId: Promise<E2BSandboxId>

  private readonly config: ResolvedConfig
  private readonly ready: Promise<Sandbox>
  private failedSetupSandbox: Sandbox | undefined
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'e2b')
    // Schemastery fills these fields before construction; the type does not encode that step.
    const resolved = config as SchemaResolvedConfig
    const apiKey = config.apiKey ?? process.env.E2B_API_KEY
    this.config = {
      apiKey: apiKey ?? '',
      cwd: resolved.cwd,
      timeoutMs: resolved.timeoutMs,
      onTimeout: resolved.onTimeout,
      onDispose: resolved.onDispose,
      ...(config.sandboxId !== undefined ? { sandboxId: config.sandboxId } : {}),
      ...(config.template !== undefined ? { template: config.template } : {}),
    }
    this.validate()
    this.cwd = this.config.cwd
    this.runtimeRoot = posix.join(this.cwd, '.dsh-e2b')
    this.created = this.config.sandboxId === undefined
    this.timeoutMode = this.config.onTimeout
    this.disposeMode = this.config.onDispose
    this.ready = this.open()
    // A deployment may load the owner before any adapter uses it. Keep a
    // failed eager connection observed; getSandbox() still returns the error.
    void this.ready.catch(() => {})
    this.sandboxId = this.ready.then(sandbox => E2BSandboxId(sandbox.sandboxId))
    void this.sandboxId.catch(() => {})

    ctx.effect(() => async () => {
      this.disposed = true
      let sandbox: Sandbox
      try {
        sandbox = await this.ready
      } catch {
        const failedSetupSandbox = this.failedSetupSandbox
        if (failedSetupSandbox === undefined) return
        sandbox = failedSetupSandbox
        try {
          await sandbox.kill()
          this.failedSetupSandbox = undefined
        } catch (error: unknown) {
          if (!(error instanceof SandboxNotFoundError)) throw error
          this.failedSetupSandbox = undefined
        }
        return
      }
      try {
        switch (this.config.onDispose) {
          case 'kill':
            await sandbox.kill()
            return
          case 'pause': {
            await sandbox.pause()
            return
          }
          case 'leave':
            return
        }
      } catch (error: unknown) {
        // A kill-on-timeout sandbox is already quiescent; every other disposal
        // failure still reports that the configured final disposition is unknown.
        if (!(error instanceof SandboxNotFoundError)) throw error
      }
    }, 'e2b sandbox teardown')
  }

  /**
   * Return the shared live SDK handle.
   * @returns the created or reconnected sandbox after the configured cwd exists.
   * @throws when E2B rejects creation/reconnection or the service is disposing.
   */
  async getSandbox(): Promise<Sandbox> {
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    const sandbox = await this.ready
    // Disposal can race the awaited sandbox readiness despite the synchronous precheck.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    return sandbox
  }

  private validate(): void {
    if (this.config.apiKey.length === 0) {
      throw new Error('dsh-e2b: configure apiKey or set E2B_API_KEY')
    }
    if (!posix.isAbsolute(this.config.cwd)) {
      throw new Error(`dsh-e2b: cwd must be an absolute Linux path: ${this.config.cwd}`)
    }
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
      throw new Error('dsh-e2b: timeoutMs must be a positive finite number')
    }
    if (this.config.sandboxId !== undefined && this.config.sandboxId.length === 0) {
      throw new Error('dsh-e2b: sandboxId must be non-empty when provided')
    }
    if (this.config.sandboxId !== undefined && this.config.template !== undefined) {
      throw new Error('dsh-e2b: template applies only when creating; omit it when sandboxId reconnects')
    }
  }

  private async open(): Promise<Sandbox> {
    const connection = {
      apiKey: this.config.apiKey,
      timeoutMs: this.config.timeoutMs,
    }
    const sandbox = this.config.sandboxId === undefined
      ? this.config.template === undefined
        ? await Sandbox.create({
          ...connection,
          secure: true,
          lifecycle: { onTimeout: this.config.onTimeout, autoResume: this.config.onTimeout === 'pause' },
        })
        : await Sandbox.create(this.config.template, {
          ...connection,
          secure: true,
          lifecycle: { onTimeout: this.config.onTimeout, autoResume: this.config.onTimeout === 'pause' },
        })
      : await Sandbox.connect(this.config.sandboxId, connection)
    try {
      await sandbox.files.makeDir(this.cwd)
      await sandbox.files.makeDir(this.runtimeRoot)
      const runtimeRoot = await sandbox.files.getInfo(this.runtimeRoot)
      if (runtimeRoot.type !== FileType.DIR || runtimeRoot.symlinkTarget !== undefined) {
        throw new Error(`dsh-e2b: runtime root must be a real directory: ${this.runtimeRoot}`)
      }
      await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(this.runtimeRoot)}`)
      return sandbox
    } catch (error: unknown) {
      if (this.created) {
        try {
          await sandbox.kill()
        } catch (_cleanupFailure) {
          // Preserve the setup failure as the public error while retaining the
          // created handle for the service disposer to retry this rollback.
          this.failedSetupSandbox = sandbox
        }
      }
      throw error
    }
  }
}

export default E2BSandboxService
