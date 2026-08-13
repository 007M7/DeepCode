/** Ink surface keyboard and secret-rendering behavior over fake TTY streams. */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { Key } from 'ink'
import { TerminalTui } from '../src/tui.ts'

const opened: TerminalTui[] = []

afterEach(() => {
  for (const tui of opened.splice(0)) tui.close()
})

/** Give React/Ink one event-loop turn to commit output. */
async function rendered(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

/** Create one deterministic fake TTY and capture its rendered bytes. */
function createTui(): { tui: TerminalTui; stdin: PassThrough; output: () => string } {
  const stdin = new PassThrough()
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) { Object.assign(stdin, { isRaw: raw }); return stdin },
    ref() { return stdin },
    unref() { return stdin },
  })
  const stdout = new PassThrough()
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30 })
  let output = ''
  stdout.on('data', (chunk: Buffer | string) => { output += chunk.toString() })
  const tui = new TerminalTui({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    unicode: false,
    identity: {
      version: '1.2.3', cwd: 'C:\\workspace', sessionId: 'session-test',
      provider: 'deepseek-official', model: 'deepseek-chat', authenticated: false,
    },
  })
  opened.push(tui)
  return { tui, stdin, output: () => output }
}

describe('TerminalTui', () => {
  it('renders the branded non-full-screen shell and completes slash commands', async () => {
    const test = createTui()
    test.tui.setCommandNames(['help', 'login'])
    const answer = test.tui.ask({ kind: 'chat', label: 'Ask DeepSeek' })
    test.tui.handleInput('/he', {} as Key)
    test.tui.handleInput('', { tab: true } as Key)
    expect(test.tui.getSnapshot().buffer).toBe('/help ')
    test.tui.handleInput('', { return: true } as Key)
    await expect(answer).resolves.toBe('/help ')
    await rendered()
    expect(test.output()).toContain('DeepSeek Harness')
    expect(test.output()).toContain('(o)')
    expect(test.output()).toContain('not authenticated')
    expect(test.output()).not.toContain('\u001B[?1049h')
  })

  it('masks a login secret and maps Ctrl+C by running state', async () => {
    const test = createTui()
    let cancellations = 0
    test.tui.onCancel(() => { cancellations += 1 })
    const secret = 'sk-test-SECRETXYZ'
    const answer = test.tui.ask({ kind: 'secret', label: 'API key' })
    test.tui.handleInput(secret, {} as Key)
    await rendered()
    expect(test.output()).not.toContain(secret)
    test.tui.handleInput('', { return: true } as Key)
    await expect(answer).resolves.toBe(secret)

    test.tui.setRunning(true)
    test.tui.handleInput('c', { ctrl: true } as Key)
    expect(cancellations).toBe(1)
    expect(test.tui.isClosed).toBe(false)
    test.tui.setRunning(false)
    test.tui.handleInput('c', { ctrl: true } as Key)
    expect(test.tui.isClosed).toBe(true)
  })

  it('toggles details for tool rows that were already rendered', async () => {
    const test = createTui()
    await rendered()
    test.tui.addTool('read_file completed', 'C:\\workspace\\secret.ts')
    await rendered()
    expect(test.output()).not.toContain('secret.ts')

    test.tui.handleInput('o', { ctrl: true } as Key)
    await rendered()
    expect(test.output()).toContain('secret.ts')
  })

  it('submits the first approval option on empty Enter so callers can default to reject', async () => {
    const test = createTui()
    const answer = test.tui.ask({ kind: 'approval', label: 'Allow command?', options: ['Reject', 'Allow once'] })
    test.tui.handleInput('', { return: true } as Key)
    await expect(answer).resolves.toBe('Reject')
  })

  it('deletes backward for both terminal Backspace encodings', async () => {
    const test = createTui()
    const answer = test.tui.ask({ kind: 'chat', label: 'Ask DeepSeek' })
    await rendered()

    test.stdin.write('abcd')
    await rendered()
    test.stdin.write('\x7f')
    await rendered()
    expect(test.tui.getSnapshot()).toMatchObject({ buffer: 'abc', cursor: 3 })

    test.stdin.write('\x08')
    await rendered()
    expect(test.tui.getSnapshot()).toMatchObject({ buffer: 'ab', cursor: 2 })

    test.tui.handleInput('cd', {} as Key)
    test.tui.handleInput('', { leftArrow: true } as Key)
    test.tui.handleInput('', { delete: true } as Key)
    expect(test.tui.getSnapshot()).toMatchObject({ buffer: 'abd', cursor: 2 })

    test.tui.handleInput('', { return: true } as Key)
    await expect(answer).resolves.toBe('abd')
  })
})
