import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
 * examples/tui-agent. `dsh list-sessions` is covered here too: it is the one surface that
 * boots no agent tree, so the built bin is the whole product path.
 * Skips before the bin is built.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')

/**
 * Run the built bin with PIPED stdio (stdin closed at EOF); resolve with output
 * + exit code. `env` isolates the Harness home for surfaces that read it.
 */
async function runBuiltBin(
  args: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<{ stdout: string; code: number; stderr: string }> {
  const result = await execa(process.execPath, [dshBin, ...args], {
    input: '',
    timeout: 25_000,
    killSignal: 'SIGKILL',
    reject: false,
    env,
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

  describe('dsh list-sessions', () => {
    let home: string
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-ls-bin-')) })
    afterEach(() => { rmSync(home, { recursive: true, force: true }) })

    it('reports an empty listing as success, not an error', async () => {
      const { stdout, code, stderr } = await runBuiltBin(['list-sessions'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(stdout.trim()).toBe('no dsh sessions running')
      expect(stderr).toBe('')
    }, 30_000)

    it('emits an empty JSON array for machines', async () => {
      const { stdout, code } = await runBuiltBin(['ps', '--json'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toEqual([])
    }, 30_000)

    it('runs without a TTY, unlike the TUI surface', async () => {
      // The listing is read-only and boots no agent tree, so piped stdio — the
      // launch the TUI refuses — is a supported way to run it.
      const { code, stderr } = await runBuiltBin(['ps'], { DSH_HOME: home })
      expect(code).toBe(0)
      expect(stderr).not.toContain('interactive TTYs')
    }, 30_000)

    it('rejects a leaked default-surface flag instead of listing', async () => {
      const { code, stderr } = await runBuiltBin(['list-sessions', '--resume', 'sess'], { DSH_HOME: home })
      expect(code).not.toBe(0)
      expect(stderr).toContain('list-sessions takes none of')
    }, 30_000)
  })
})
