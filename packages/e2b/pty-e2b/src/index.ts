/** E2B byte-PTY backend for persistent interactive terminal sessions. */

import { posix } from 'node:path'
import type { Context } from 'cordis'
import type { CommandHandle, Sandbox } from '@deepseek-ai/dsh-e2b'
import { PtyBackendCleanupError } from '@deepseek-ai/dsh-pty'
import type { PtyBackend, PtyBackendSpawnSpec } from '@deepseek-ai/dsh-pty'
import { type Config, type ResolvedConfig, validateConfig } from './config.ts'
import { E2BPtySession } from './session.ts'

export { Config } from './config.ts'
export type { Config as PtyE2BConfig } from './config.ts'
export { E2BPtySession } from './session.ts'

/** Cordis plugin name. */
export const name = 'pty-e2b'
/** Required shared sandbox owner and PTY registry. */
export const inject = ['e2b', 'pty']

function terminalEnvironment(spec: PtyBackendSpawnSpec): Record<string, string> {
  return {
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    PS1: 'dsh> ',
    PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    DSH_SHELL: '1',
    DSH_SESSION_ID: spec.owner.id,
    DSH_PTY_SESSION_ID: spec.sessionId,
  }
}

/** E2B backend registered under the configured terminal type. */
export class E2BPtyBackend implements PtyBackend {
  readonly type: string

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly createPty: (
      sandbox: Sandbox,
      options: Parameters<Sandbox['pty']['create']>[0],
    ) => Promise<CommandHandle> = (sandbox, options) => sandbox.pty.create(options),
  ) {
    this.type = config.backendType
  }

  /** Create, initialize, and publish one remote PTY session. */
  async spawn(spec: PtyBackendSpawnSpec): Promise<E2BPtySession> {
    spec.signal?.throwIfAborted()
    const sandbox = await this.ctx.e2b.getSandbox()
    spec.signal?.throwIfAborted()
    const pending: Uint8Array[] = []
    const created: { session?: E2BPtySession } = {}
    const handle = await this.createPty(sandbox, {
      rows: this.config.rows,
      cols: this.config.cols,
      cwd: posix.resolve(this.ctx.e2b.cwd, spec.cwd ?? this.ctx.e2b.cwd),
      envs: terminalEnvironment(spec),
      timeoutMs: 0,
      ...spec.signal === undefined ? {} : { signal: spec.signal },
      onData: (data) => {
        if (created.session === undefined) pending.push(Uint8Array.from(data))
        else created.session.onData(data)
      },
    })
    if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) {
      await handle.kill().catch(() => false)
      throw new Error(`pty-e2b: E2B returned invalid PTY pid ${handle.pid}`)
    }
    const session = new E2BPtySession(sandbox, handle, this.config)
    created.session = session
    try {
      const initializing = session.initialize(spec.signal)
      for (const data of pending) session.onData(data)
      await initializing
      return session
    } catch (error: unknown) {
      try {
        await session.close('E2B PTY startup failed')
      } catch (cleanupError: unknown) {
        throw new PtyBackendCleanupError(error, cleanupError)
      }
      throw error
    }
  }
}

/** Register the E2B PTY backend. */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  ctx.pty.registerBackend(new E2BPtyBackend(ctx, config))
}
