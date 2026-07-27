import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Published-entry smoke for the `dsh` bin: run the built `lib/bin.js` under
 * plain Node (no tsx) with PIPED stdio and assert the TUI refuses to boot.
 * `dsh` is the sole terminal front door; the TUI owns no non-TTY fallback, so a
 * piped launch must exit nonzero with a stderr pointer at the one-shot `-p`
 * mode. The guard fires inside `runTui` BEFORE the Loader resolves the config
 * tree — a compose-time throw inside the tree is logged per-entry, not
 * rethrown, so without this guard a piped launch would settle into an idle
 * UI-less process. The bin resolves its workspace deps through the repo's
 * node_modules, so no external consumer is assembled; missing-config fail-loud
 * and full-boot coverage for the shared dsh-app-boot glue live in cli-demo's
 * built-bin suite, and interactive TTY behavior is PTY-covered by
 * examples/tui-agent. Skips before the bin is built.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')

/** Run the built bin with PIPED stdio (stdin closed at EOF); resolve with output + exit code. */
async function runBuiltBin(): Promise<{ stdout: string; code: number; stderr: string }> {
  const result = await execa(process.execPath, [dshBin], {
    input: '',
    timeout: 25_000,
    killSignal: 'SIGKILL',
    reject: false,
  })
  if (result.timedOut) {
    throw new Error(`dsh built bin did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return { stdout: result.stdout, code: result.exitCode ?? -1, stderr: result.stderr }
}

describe.skipIf(!existsSync(dshBin))('dsh BUILT bin (node lib/bin.js, no tsx)', () => {
  it('refuses pipes LOUD (non-zero exit + stderr) before booting the Loader', async () => {
    const { stdout, code, stderr } = await runBuiltBin()
    expect(code).not.toBe(0)
    expect(stderr).toContain('requires stdin and stdout to be interactive TTYs')
    expect(stderr).toContain('dsh -p')
    // The refusal happens before any plugin mounts: stdout stays silent.
    expect(stdout).toBe('')
  }, 30_000)
})
