import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless Loader-path smoke for examples/coding-agent: boot the real example
 * through the stdio-agent bin and its `cordis.yml`, then close stdin without a
 * prompt and assert the banner. The dummy key satisfies adapter construction;
 * immediate EOF guarantees there is no model call.
 */

const binScript = fileURLToPath(new URL('../../../packages/ui/stdio-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('coding-agent keyless smoke (real cordis.yml via the Loader)', () => {
  it('boots the full plugin tree, prints its banner, and exits cleanly on EOF', async () => {
    const { stdout } = await runLoaderSmoke({
      label: 'coding-agent',
      tempDirPrefix: 'coding-smoke-',
      binScript,
      configPath,
      tsconfigPath,
      env: { DEEPSEEK_API_KEY: 'keyless-smoke-no-call' },
    })
    expect(stdout).toContain('agent REPL ready.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
