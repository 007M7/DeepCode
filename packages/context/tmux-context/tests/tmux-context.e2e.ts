import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/tmux-context-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/tmux-context.cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('tmux-context through a real headless cordis.yml', () => {
  it('injects one ordered tmux-location event on the first turn and suppresses the unchanged second', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'tmux-context headless smoke',
      tempDirPrefix: 'tmux-context-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)

    const contexts = events.filter(
      (event): event is SessionEvent<'user/message'> =>
        event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'tmux-context')
    // Two identical-state turns: the location injects once and is suppressed after.
    expect(contexts).toHaveLength(1)

    const [reading] = contexts
    if (reading === undefined) throw new Error('missing tmux-context reading')
    const starts = events.filter(event => event.type === 'step/start')
    expect(reading.seq).toBeLessThan(starts[0]!.seq)
    expect(reading.surfaceOp).toBe('append')

    const text = reading.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(text).toBe(
      'tmux location (turn 1):\n'
      + 'session work, window 0 "editor", pane 1 %3\n'
      + 'window active=1, pane active=1, layout a1b2,80x24,0,0,4',
    )

    const headers = events.filter(event => event.type === 'request/header')
    expect(JSON.stringify(headers)).not.toContain('tmux location (turn')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
