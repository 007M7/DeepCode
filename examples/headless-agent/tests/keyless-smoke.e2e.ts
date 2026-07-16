import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('../../../packages/examples/cli-demo/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cli.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('headless-agent keyless smoke', () => {
  it('boots the real Loader tree, runs a real bash tool round trip, and persists the turn', async () => {
    let persisted = false
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'headless-agent',
      tempDirPrefix: 'headless-agent-smoke-',
      binScript,
      configPath,
      binArgs: ['--config', configPath, '--output-format', 'stream-json', 'prove the tool path'],
      tsconfigPath,
      inspect: async (cwd) => {
        const files = await readdir(cwd, { recursive: true })
        persisted = files.some(file => file.endsWith('.jsonl'))
      },
    })
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    const result = lines.at(-1)
    expect(stderr).toBe('')
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'bash')).toBe(true)
    const toolResult = events.find(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResult)).toContain('CLI_TOOL_ROUND_TRIP')
    expect(result).toMatchObject({
      type: 'result',
      success: true,
      turn: 1,
      reason: { kind: 'completed' },
      usage: { inputTokens: 18, outputTokens: 8, cacheReadTokens: 2, reasoningTokens: 1 },
    })
    expect(String(result?.['result'])).toContain('CLI_TOOL_ROUND_TRIP')
    expect(persisted).toBe(true)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
