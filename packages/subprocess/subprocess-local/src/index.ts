/**
 * Local implementation of the subprocess seam. Each spawn is a detached
 * process tree with the spec's per-stream stdio dispositions; disposal
 * terminates and joins live trees. It has no config: every disposition and
 * limit arrives on the spec, so the deployment-varying choices stay with the
 * calling seam's config (the bash executor's, the LSP host's, …).
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { constants } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { access, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { Context } from 'cordis'
import * as nodePty from 'node-pty'
import type { IPtyForkOptions } from 'node-pty'
import { SubprocessService } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { childEnv, spawnSubprocess } from './spawn.ts'
import type { SpawnInternals } from './spawn.ts'
import { createProcessInspector } from './process-inspector.ts'
import type { ProcessInspector } from './process-inspector.ts'
import { LocalTerminalHandle } from './terminal.ts'

/**
 * Local subprocess service: detached process trees, Node-shaped stdio
 * dispositions (raw pipes, inherit, bounded tail-keep collection with spill
 * files), credential-scrubbed environment, and tree-scoped signalling with
 * SIGTERM→grace→SIGKILL escalation.
 */
export class LocalSubprocessService extends SubprocessService {
  readonly cwd = process.cwd()
  readonly runtimeRoot = mkdtempSync(join(tmpdir(), 'dsh-subprocess-runtime-'))
  /** Live handles retained only so disposal can terminate and join them. */
  private live = new Set<SubprocessHandle>()
  /** Live terminal sessions retained through whole-session quiescence. */
  private terminals = new Set<SubprocessTerminalHandle>()
  /** Test seam: spill and platform knobs forwarded to spawnSubprocess. */
  internals: SpawnInternals = {}
  /** Test seam for platform process inspection; production resolves lazily on terminal spawn. */
  terminalInspector: ProcessInspector | undefined

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      // Terminate (escalating), then await WHOLE-TREE exit — not just the
      // direct child's settlement — so even a TERM-trapping descendant cannot
      // outlive the fiber.
      const pending: Promise<unknown>[] = []
      for (const handle of this.live) {
        handle.terminate()
        // Spawn-failure rejections already settled and left the live set.
        pending.push(handle.done.catch(() => {}).then(() => handle.waitForExit()))
      }
      for (const terminal of this.terminals) {
        terminal.terminate()
        // Cleanup may reject before the top-level process exits (for example,
        // an identity-fenced descendant survives escalation). Await the cleanup
        // transaction directly so disposal reports that failure rather than
        // waiting forever on `done`.
        pending.push(terminal.waitForExit())
      }
      this.live.clear()
      this.terminals.clear()
      await Promise.all(pending)
      await rm(this.runtimeRoot, { recursive: true, force: true })
    }, 'local subprocess teardown')
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-local: executable must be non-empty')
    signal?.throwIfAborted()
    const environment = childEnv(env)
    const absolute = isAbsolute(command)
    const candidates = absolute ? [command] : this.executableCandidates(command, environment)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await access(candidate, constants.X_OK)
        signal?.throwIfAborted()
        return candidate
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted()
    throw new Error(absolute
      ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
      : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = env.PATH ?? ''
    const extensions = process.platform === 'win32' && extname(command) === ''
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
    return path.split(delimiter).flatMap(directory =>
      directory === '' ? [] : extensions.map(extension => resolve(this.cwd, directory, command + extension)))
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = spawnSubprocess(spec, this.internals)
    this.live.add(handle)
    // Release ownership only once the whole TREE is gone, not at direct-child
    // settlement — a TERM-trapping helper that outlives the leader must stay
    // owned so teardown can still escalate it. For the common no-survivor
    // case waitForExit resolves immediately after settlement.
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => { this.live.delete(handle) })
    handle.done.then(release, release)
    return handle
  }

  // Local PTY allocation is synchronous, but the provider seam permits remote asynchronous allocation.
  // eslint-disable-next-line @typescript-eslint/require-await
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-local: terminal argv must contain a program')
    }
    for (const [name, value] of [['rows', spec.rows], ['cols', spec.cols], ['graceMs', spec.graceMs]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`subprocess-local: terminal ${name} must be a positive safe integer`)
      }
    }
    spec.signal?.throwIfAborted()
    const options: IPtyForkOptions = {
      name: 'dumb',
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: childEnv(spec.env),
    }
    const inspector = this.terminalInspector ?? createProcessInspector()
    const terminal = nodePty.spawn(file, [...spec.argv.slice(1)], options)
    const handle = new LocalTerminalHandle(terminal, inspector, spec.graceMs, spec.signal)
    this.terminals.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.terminals.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

export default LocalSubprocessService
