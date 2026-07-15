import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless-by-nature Loader-path coverage for examples/echo-agent. The real
 * tree uses its deterministic mock model, so this suite is both the boot smoke
 * and the complete behavior proof for the example.
 */

const binScript = fileURLToPath(new URL('../../../packages/ui/stdio-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

async function runEcho(stdinLines: readonly string[]): Promise<string> {
  const { stdout } = await runLoaderSmoke({
    label: 'echo-agent',
    tempDirPrefix: 'echo-smoke-',
    binScript,
    configPath,
    tsconfigPath,
    stdinLines,
  })
  return stdout
}

describe('echo-agent keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots, prints its welcome banner, and exits cleanly on stdin EOF', async () => {
    expect(await runEcho([])).toContain('echo-agent ready.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('runs the echo tool round-trip for an "echo …" line', async () => {
    const stdout = await runEcho(['echo hello world'])
    expect(stdout).toContain('[tool call] echo')
    expect(stdout).toContain('[tool result] ECHO: HELLO WORLD')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('streams a direct canned reply for a non-echo line', async () => {
    const stdout = await runEcho(['just chatting'])
    expect(stdout).toContain('just chatting')
    expect(stdout).not.toContain('[tool call]')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
