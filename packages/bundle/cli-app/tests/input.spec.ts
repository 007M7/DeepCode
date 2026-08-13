/**
 * The single line-editor owner: normal reads, concurrency, abort reuse, EOF and
 * explicit close. These pin the close/EOF race that readline/promises does not
 * settle on its own.
 */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { CliInput } from '../src/input.ts'

const inputs: CliInput[] = []
afterEach(() => {
  for (const input of inputs.splice(0)) input.close()
})

/** Stage a CliInput over an in-memory stdin and a prompt-swallowing output. */
function makeInput(): { input: CliInput; stdin: PassThrough } {
  const stdin = new PassThrough()
  const output = { write: () => true } as unknown as NodeJS.WritableStream
  const input = new CliInput({ input: stdin, output })
  inputs.push(input)
  return { input, stdin }
}

describe('CliInput', () => {
  it('reads one line and returns it without the trailing newline', async () => {
    const { input, stdin } = makeInput()
    const pending = input.ask('> ')
    stdin.write('hello\n')
    await expect(pending).resolves.toBe('hello')
  })

  it('retains piped lines until successive prompts consume them', async () => {
    const { input, stdin } = makeInput()
    stdin.end('first\nsecond\n')
    await expect(input.ask('> ')).resolves.toBe('first')
    await expect(input.ask('> ')).resolves.toBe('second')
    await expect(input.ask('> ')).rejects.toThrow(/the input (?:is closed|closed before an answer arrived)/u)
  })

  it('rejects a concurrent ask instead of opening a second editor', async () => {
    const { input, stdin } = makeInput()
    const first = input.ask('> ')
    await expect(input.ask('> ')).rejects.toThrow('a question is already pending')
    stdin.write('hello\n')
    await expect(first).resolves.toBe('hello')
  })

  it('cancels the pending read on abort and stays reusable', async () => {
    const { input, stdin } = makeInput()
    const controller = new AbortController()
    const pending = input.ask('> ', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    const again = input.ask('> ')
    stdin.write('second\n')
    await expect(again).resolves.toBe('second')
  })

  it('rejects a pending ask and flags closed when stdin reaches EOF', async () => {
    const { input, stdin } = makeInput()
    const pending = input.ask('> ')
    stdin.end()
    await expect(pending).rejects.toThrow('the input closed before an answer arrived')
    expect(input.isClosed).toBe(true)
  })

  it('rejects a pending ask on close and closes idempotently', async () => {
    const { input } = makeInput()
    const pending = input.ask('> ')
    input.close()
    await expect(pending).rejects.toThrow('the input closed before an answer arrived')
    expect(input.isClosed).toBe(true)
    expect(() => { input.close() }).not.toThrow()
    await expect(input.ask('> ')).rejects.toThrow('the input is closed')
  })

  it('forwards terminal Ctrl+C after a completed question', async () => {
    const stdin = new PassThrough()
    Object.assign(stdin, {
      isTTY: true,
      isRaw: false,
      setRawMode(raw: boolean) {
        Object.assign(stdin, { isRaw: raw })
        return stdin
      },
    })
    const output = new PassThrough()
    const input = new CliInput({ input: stdin, output, terminal: true })
    inputs.push(input)
    let interrupted = false
    input.onSigint(() => { interrupted = true })
    const pending = input.ask('> ')
    stdin.write('start\n')
    await expect(pending).resolves.toBe('start')

    stdin.write('\x03')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(interrupted).toBe(true)
  })
})
