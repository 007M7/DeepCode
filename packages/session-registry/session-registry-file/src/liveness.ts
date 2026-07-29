/**
 * Process-liveness probe for stored registry records.
 * @module @deepseek-ai/dsh-session-registry-file/liveness
 */

/**
 * Signal-0 probe: report whether a pid currently exists.
 *
 * `kill(pid, 0)` sends no signal and only tests existence. `ESRCH` means no such
 * process. `EPERM` means the process exists but is owned by another user, which
 * is still alive — reporting it dead would drop a live record. Any other errno
 * is unexpected and propagates rather than being read as a liveness answer.
 * @param pid - the operating-system process id to probe.
 * @param kill - signal sender, defaulting to `process.kill`; injected by tests.
 * @returns whether a process with this pid exists.
 */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = process.kill.bind(process),
): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}
