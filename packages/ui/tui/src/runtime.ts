/**
 * Host and process boundary the interactive TUI runs against: the resume-handoff
 * host and the {@link TuiRuntime} the shipped CLI supplies (terminal, process
 * exit, clock, and optional prompt/git overrides). These are plain interfaces so
 * tests can drive the channel with a fake terminal.
 * @module @deepseek-ai/dsh-tui/runtime
 */

import type { Terminal } from '@earendil-works/pi-tui'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Process-lifecycle owner used by the shipped CLI for an atomic resume handoff. */
export interface TuiResumeHost {
  /**
   * Dispose the current app and replace it with a runtime for `sessionId`.
   * Success does not return. A host may reject before it commits teardown;
   * after commit it owns fatal reporting and process exit.
   * @param sessionId - validated persisted session selected by the user.
   */
  handoff(sessionId: SessionId): Promise<never>
}

/** Runtime boundary used by the interactive TUI. */
export interface TuiRuntime {
  /** Terminal implementation; production uses pi-tui's `ProcessTerminal`. */
  terminal: Terminal
  /** Exit hook used by terminal shutdown or a target-agent startup failure. */
  exit(code: number): void
  /**
   * Override the prompt's logical working-directory label without changing the session directory used by tools.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped label; the TUI makes terminal controls visible.
   */
  formatCwd?: (cwd: string | undefined) => string
  /**
   * Override the Git branch shown in the prompt context line; production resolves it once at mount.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped branch name, or `undefined` outside a Git worktree.
   */
  gitBranch?: (cwd: string) => string | undefined
  /** Monotonic-enough wall clock for elapsed status rendering. Defaults to `Date.now`. */
  now?(): number
  /** Host-owned process handoff; absent leaves `resumeCommand` as the fallback. */
  handoffResume?: TuiResumeHost['handoff']
}
