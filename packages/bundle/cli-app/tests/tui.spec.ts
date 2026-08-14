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
    identity: {
      version: '1.2.3', cwd: 'C:\\workspace', sessionId: 'session-test',
      provider: 'deepseek-official', model: 'deepseek-chat', authenticated: false,
    },
  })
  opened.push(tui)
  return { tui, stdin, output: () => output }
}

describe('TerminalTui', () => {
  it('renders the compact non-full-screen shell and completes slash commands', async () => {
    const test = createTui()
    test.tui.setCommandNames(['help', 'login'])
    const answer = test.tui.ask({ kind: 'chat', label: 'Ask DeepCode' })
    test.tui.handleInput('/he', {} as Key)
    test.tui.handleInput('', { tab: true } as Key)
    expect(test.tui.getSnapshot().buffer).toBe('/help ')
    test.tui.handleInput('', { return: true } as Key)
    await expect(answer).resolves.toBe('/help ')
    await rendered()
    expect(test.output()).toContain('DeepCode')
    expect(test.output()).toContain('v1.2.3')
    expect(test.output()).not.toContain('Local Agent CLI')
    expect(test.output()).toContain('not authenticated')
    expect(test.output()).not.toContain('\u001B[?1049h')
  })

  it('queues complete chat messages while a turn is running', async () => {
    const test = createTui()
    const first = test.tui.ask({ kind: 'chat', label: 'Ask DeepCode' })
    test.tui.handleInput('first', {} as Key)
    test.tui.handleInput('', { return: true } as Key)
    await expect(first).resolves.toBe('first')

    test.tui.setRunning(true)
    test.tui.handleInput('second', {} as Key)
    test.tui.handleInput('', { return: true } as Key)
    expect(test.tui.getSnapshot()).toMatchObject({ queuedChats: 1, buffer: '' })

    test.tui.setRunning(false)
    await expect(test.tui.ask({ kind: 'chat', label: 'Ask DeepCode' })).resolves.toBe('second')
    expect(test.tui.getSnapshot().queuedChats).toBe(0)
  })

  it('lets an approval own the composer without discarding queued chat', async () => {
    const test = createTui()
    const first = test.tui.ask({ kind: 'chat', label: 'Ask DeepCode' })
    test.tui.handleInput('first', {} as Key)
    test.tui.handleInput('', { return: true } as Key)
    await expect(first).resolves.toBe('first')
    test.tui.setRunning(true)
    test.tui.handleInput('queued', {} as Key)
    test.tui.handleInput('', { return: true } as Key)

    const approval = test.tui.ask({ kind: 'approval', label: 'Allow read?', options: ['Reject', 'Allow once'] })
    expect(test.tui.getSnapshot()).toMatchObject({ prompt: { kind: 'approval' }, queuedChats: 1 })
    test.tui.handleInput('', { return: true } as Key)
    await expect(approval).resolves.toBe('Reject')
    expect(test.tui.getSnapshot()).toMatchObject({ prompt: { kind: 'chat' }, queuedChats: 1 })

    test.tui.setRunning(false)
    await expect(test.tui.ask({ kind: 'chat', label: 'Ask DeepCode' })).resolves.toBe('queued')
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
    await rendered()
    expect(test.output()).toContain('DeepCode is working')
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

  it('commits history once while streaming only the live response area', async () => {
    const test = createTui()
    await rendered()
    test.tui.addUser('keep the scrollbar stable')
    test.tui.appendAssistant('first ')
    await rendered()
    test.tui.appendAssistant('second ')
    test.tui.appendAssistant('third')
    await rendered()

    expect(test.output().match(/DeepCode v1\.2\.3/gu)).toHaveLength(1)
    expect(test.output().match(/keep the scrollbar stable/gu)).toHaveLength(1)
    expect(test.tui.getSnapshot().activeAssistant).toBe('first second third')

    const beforeCommit = test.output().length
    test.tui.endAssistant()
    await rendered()
    expect(test.output().slice(beforeCommit).match(/first second third/gu)).toHaveLength(1)
    expect(test.tui.getSnapshot().activeAssistant).toBe('')
  })

  it('updates live identity without reprinting the static welcome card', async () => {
    const test = createTui()
    await rendered()
    test.tui.setIdentity({
      version: '1.2.3', cwd: 'C:\\workspace', sessionId: 'session-next',
      provider: 'deepseek-official', model: 'deepseek-reasoner', authenticated: true,
    })
    await rendered()

    expect(test.output().match(/DeepCode v1\.2\.3/gu)).toHaveLength(1)
    expect(test.output()).toContain('deepseek-official/deepseek-reasoner')
    expect(test.output()).toContain('authenticated')
    expect(test.output()).toContain('session session-next')
    expect(test.tui.getSnapshot().identity).toMatchObject({
      sessionId: 'session-next', model: 'deepseek-reasoner', authenticated: true,
    })
  })

  it('clears the terminal and discards the old Ink static owner', async () => {
    const test = createTui()
    await rendered()
    test.tui.addUser('history before clear')
    await rendered()
    const before = test.output().length

    test.tui.clear()
    await rendered()
    const cleared = test.output().slice(before)

    expect(cleared).toContain('\u001B[2J\u001B[3J\u001B[H')
    expect(cleared).not.toContain('history before clear')
  })

  it('shows only the latest tool detail in the live panel', async () => {
    const test = createTui()
    test.tui.addTool('first tool', 'old detail')
    test.tui.addTool('second tool', 'current detail')
    await rendered()
    const before = test.output().length

    test.tui.handleInput('o', { ctrl: true } as Key)
    await rendered()
    const details = test.output().slice(before)

    expect(details).toContain('current detail')
    expect(details).not.toContain('old detail')
  })

  it('submits the first approval option on empty Enter so callers can default to reject', async () => {
    const test = createTui()
    const answer = test.tui.ask({ kind: 'approval', label: 'Allow command?', options: ['Reject', 'Allow once'] })
    test.tui.handleInput('', { return: true } as Key)
    await expect(answer).resolves.toBe('Reject')
  })

  it('deletes backward for both terminal Backspace encodings', async () => {
    const test = createTui()
    const answer = test.tui.ask({ kind: 'chat', label: 'Ask DeepCode' })
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
