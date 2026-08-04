type ExecFileCallback = (
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr: string,
) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: { encoding: string; signal: AbortSignal; windowsHide: boolean },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { describe, expect, it, vi } from 'vitest'
import { openNativePath, openNativeTextFile, type PathOpenerRunner } from '../src/native-path-opener.ts'

const signal = () => new AbortController().signal

describe('native path opener', () => {
  it('opens with macOS open(1)', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativePath('/Users/test/file.txt', signal(), { platform: 'darwin', run })
    expect(run).toHaveBeenCalledWith('open', ['/Users/test/file.txt'], expect.any(AbortSignal))
  })

  it('bypasses macOS file associations for text documents', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativeTextFile('/Users/test/settings.yaml', signal(), { platform: 'darwin', run })
    expect(run).toHaveBeenCalledWith('open', ['-t', '/Users/test/settings.yaml'], expect.any(AbortSignal))
  })

  it('uses the Linux desktop association for text documents', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativeTextFile('/tmp/settings.yaml', signal(), { platform: 'linux', run })
    expect(run).toHaveBeenCalledWith('xdg-open', ['/tmp/settings.yaml'], expect.any(AbortSignal))
  })

  it('opens with Windows Invoke-Item and escapes single quotes', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativePath("C:\\work\\o'reilly.txt", signal(), { platform: 'win32', run })
    expect(run).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', "Invoke-Item -LiteralPath 'C:\\work\\o''reilly.txt'"],
      expect.any(AbortSignal),
    )
  })

  it('uses the Windows desktop association for text documents', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativeTextFile('C:\\work\\settings.yaml', signal(), { platform: 'win32', run })
    expect(run).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', "Invoke-Item -LiteralPath 'C:\\work\\settings.yaml'"],
      expect.any(AbortSignal),
    )
  })

  it('opens with Linux xdg-open', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativePath('/tmp/a.txt', signal(), { platform: 'linux', run })
    expect(run).toHaveBeenCalledWith('xdg-open', ['/tmp/a.txt'], expect.any(AbortSignal))
  })

  it('rejects unsupported platforms', async () => {
    await expect(openNativePath('/x', signal(), { platform: 'freebsd' as NodeJS.Platform }))
      .rejects.toThrow('unsupported on freebsd')
  })

  it('uses the current process platform when no platform override is supplied', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativePath('/tmp/platform-default.txt', signal(), { run })
    const expected = process.platform === 'win32'
      ? 'powershell.exe'
      : process.platform === 'linux'
        ? 'xdg-open'
        : 'open'
    expect(run.mock.calls[0]?.[0]).toBe(expected)
  })

  it('runs the default command adapter without a shell and preserves command failures', async () => {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, '', '')
    })
    await openNativePath('/tmp/default.txt', signal(), { platform: 'darwin' })
    const [command, args, options] = execFileMock.mock.calls[0]!
    expect(command).toBe('open')
    expect(args).toEqual(['/tmp/default.txt'])
    expect(options.encoding).toBe('utf8')
    expect(options.windowsHide).toBe(true)
    expect(options.signal).toBeInstanceOf(AbortSignal)

    const commandError = Object.assign(new Error('open failed'), { code: 1 })
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(commandError, 'partial output', 'failure details')
    })
    await expect(openNativePath('/tmp/missing.txt', signal(), { platform: 'darwin' })).rejects.toMatchObject({
      message: 'open failed', cause: commandError, code: 1,
      stdout: 'partial output', stderr: 'failure details',
    })
  })
})
