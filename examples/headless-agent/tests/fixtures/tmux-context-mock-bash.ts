import type { Context } from 'cordis'
import { BashExecutor } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from '@deepseek-ai/dsh-bash'

/**
 * Deterministic `ctx.bash` for the tmux-context Loader fixture: any command
 * (the plugin's `tmux display-message`) returns a fixed tab-delimited reading,
 * so the injected tmux location is stable without a real tmux server. `start()`
 * throws — tmux-context must never spawn a background process.
 */
class TmuxMockBash extends BashExecutor {
  override resolve(request: BashExecRequest): BashExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      signal: request.signal,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override run(_spec: BashExecSpec): Promise<BashRunResult> {
    const line = ['work', '0', 'editor', '1', '%3', '1', '1', 'a1b2,80x24,0,0,4'].join('\\t')
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 60_000,
      stdout: { text: `${line}\n`, truncated: false },
      stderr: { text: '', truncated: false },
    })
  }

  override start(): BashProcess {
    throw new Error('tmux-context must never start a background task')
  }
}

export const name = 'tmux-context-mock-bash'

/** Register the deterministic `ctx.bash` executor for the fixture. */
export function apply(ctx: Context): void {
  ctx.plugin(TmuxMockBash)
}
