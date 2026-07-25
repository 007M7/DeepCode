import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** Run the built bin with PIPED stdio; resolve with output + exit code. */
function runBuiltBin(): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dshBin], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { stdout += c })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => { stderr += c })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dsh built bin did not exit within 25s. stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 25_000)
    // Resolve on `close` (all stdio drained), not `exit`, so captured output is complete.
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, code: code ?? -1, stderr }) })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.stdin.end()
  })
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
