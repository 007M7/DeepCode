import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('../../../packages/examples/cli-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

async function runEcho(task: string, outputFormat: 'text' | 'stream-json' = 'text'): Promise<string> {
  const { stdout } = await runLoaderSmoke({
    label: 'echo-agent',
    tempDirPrefix: 'echo-smoke-',
    binScript,
    configPath,
    binArgs: ['--config', configPath, '--output-format', outputFormat, task],
    tsconfigPath,
  })
  return stdout
}

describe('echo-agent keyless smoke (Headless through the real Loader tree)', () => {
  it('runs the echo tool round-trip and exposes both events in stream-json', async () => {
    const lines = (await runEcho('echo hello world', 'stream-json'))
      .trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'echo')).toBe(true)
    expect(JSON.stringify(events.find(event => event.type === 'tool/result'))).toContain('ECHO: HELLO WORLD')
    expect(lines.at(-1)).toMatchObject({ type: 'result', success: true })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints the final canned reply for a direct one-shot task', async () => {
    const stdout = await runEcho('just chatting')
    expect(stdout).toContain('You said: "just chatting"')
    expect(stdout).not.toContain('tool/call')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
