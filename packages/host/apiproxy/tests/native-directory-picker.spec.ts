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
import { pickNativeDirectory, type DirectoryPickerRunner } from '../src/native-directory-picker.ts'

function failure(code: string | number, stderr = ''): Error {
  return Object.assign(new Error(`command failed: ${String(code)}`), { code, stderr })
}

const signal = () => new AbortController().signal

describe('native directory picker', () => {
  it('uses the macOS folder chooser and maps user cancellation to null', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/Users/test/project/\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBe('/Users/test/project/')
    expect(run).toHaveBeenCalledWith('osascript', expect.arrayContaining(['POSIX path of selectedFolder']), expect.any(AbortSignal))

    run.mockRejectedValueOnce(failure(1, 'execution error: User canceled. (-128)'))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBeNull()

    run.mockRejectedValueOnce(failure(2, 'permission denied'))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).rejects.toThrow('command failed')
  })

  it.each([
    ['a primitive error', 'failed'],
    ['an invalid code type', { code: true }],
    ['a missing stderr property', { code: 1 }],
    ['a non-string stderr property', { code: 1, stderr: 42 }],
  ])('does not mistake %s for macOS cancellation', async (_label, reason) => {
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw reason })
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).rejects.toBe(reason)
  })

  it('uses the Windows STA folder dialog and maps empty output to cancellation', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: 'C:\\work\\project\r\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run })).resolves.toBe('C:\\work\\project')
    expect(run).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-STA', '-Command']),
      expect.any(AbortSignal),
    )
    expect(run.mock.calls[0]?.[1].at(-1)).toContain("$ErrorActionPreference = 'Stop'")
    run.mockResolvedValueOnce({ stdout: '', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run })).resolves.toBeNull()
    run.mockRejectedValueOnce(failure(1, 'Add-Type failed'))
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run })).rejects.toThrow('command failed')
  })

  it('runs the default command adapter without a shell and preserves command failures', async () => {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, 'C:\\work\\default\r\n', '')
    })
    await expect(pickNativeDirectory(signal(), { platform: 'win32' })).resolves.toBe('C:\\work\\default')
    const [command, args, options] = execFileMock.mock.calls[0]!
    expect(command).toBe('powershell.exe')
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-STA', '-Command']))
    expect(options.encoding).toBe('utf8')
    expect(options.windowsHide).toBe(true)
    expect(options.signal).toBeInstanceOf(AbortSignal)

    const commandError = Object.assign(new Error('powershell failed'), { code: 7 })
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(commandError, 'partial output', 'failure details')
    })
    await expect(pickNativeDirectory(signal(), { platform: 'win32' })).rejects.toMatchObject({
      message: 'powershell failed', cause: commandError, code: 7,
      stdout: 'partial output', stderr: 'failure details',
    })
  })

  it('uses the current process platform when no platform override is supplied', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/default/platform\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { run })).resolves.toBe('/default/platform')
  })

  it('uses Zenity on Linux and falls back to KDialog only when Zenity is missing', async () => {
    const run = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockResolvedValueOnce({ stdout: '/home/test/project\n', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run })).resolves.toBe('/home/test/project')
    expect(run.mock.calls.map(call => call[0])).toEqual(['zenity', 'kdialog'])

    const zenity = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/home/test/direct\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: zenity }))
      .resolves.toBe('/home/test/direct')
    expect(zenity).toHaveBeenCalledOnce()
  })

  it('maps Linux cancellation to null and reports a missing desktop picker', async () => {
    const cancelled = vi.fn<DirectoryPickerRunner>(async () => { throw failure(1) })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: cancelled })).resolves.toBeNull()

    const missing = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ENOENT') })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: missing }))
      .rejects.toThrow('install zenity or kdialog')

    const kdialogCancelled = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockRejectedValueOnce(failure(1))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: kdialogCancelled }))
      .resolves.toBeNull()

    const zenityFailed = vi.fn<DirectoryPickerRunner>(async () => { throw failure(2) })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: zenityFailed }))
      .rejects.toThrow('command failed')

    const kdialogFailed = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockRejectedValueOnce(failure(2))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: kdialogFailed }))
      .rejects.toThrow('command failed')
  })

  it('does not convert caller aborts into user cancellation', async () => {
    const abort = new AbortController()
    abort.abort(new Error('closed'))
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ABORT_ERR') })
    await expect(pickNativeDirectory(abort.signal, { platform: 'linux', run })).rejects.toThrow('command failed')
  })

  it('reports unsupported platforms', async () => {
    await expect(pickNativeDirectory(signal(), { platform: 'aix' })).rejects.toThrow('unsupported on aix')
  })
})
