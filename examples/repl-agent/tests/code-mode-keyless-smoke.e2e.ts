import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless Loader-path smoke for the Code Mode overlay: boot the real include
 * tree through stdio-agent and `code-mode.cordis.yml`, then close stdin without
 * a prompt and assert the banner. No model or `run_code` turn runs.
 */

const binScript = fileURLToPath(new URL('../../../packages/examples/stdio-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../code-mode.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('code-mode overlay keyless smoke (real code-mode.cordis.yml via the Loader)', () => {
  it('boots the Code Mode plugin tree, prints its banner, and exits cleanly on EOF', async () => {
    const { stdout } = await runLoaderSmoke({
      label: 'code-mode overlay',
      tempDirPrefix: 'code-mode-smoke-',
      binScript,
      configPath,
      tsconfigPath,
      env: { DEEPSEEK_API_KEY: 'keyless-smoke-no-call' },
    })
    expect(stdout).toContain('code-mode agent ready.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
