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

  it('uses Zenity on Linux and falls back to KDialog only when Zenity is missing', async () => {
    const run = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockResolvedValueOnce({ stdout: '/home/test/project\n', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run })).resolves.toBe('/home/test/project')
    expect(run.mock.calls.map(call => call[0])).toEqual(['zenity', 'kdialog'])
  })

  it('maps Linux cancellation to null and reports a missing desktop picker', async () => {
    const cancelled = vi.fn<DirectoryPickerRunner>(async () => { throw failure(1) })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: cancelled })).resolves.toBeNull()

    const missing = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ENOENT') })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: missing }))
      .rejects.toThrow('install zenity or kdialog')
  })

  it('does not convert caller aborts into user cancellation', async () => {
    const abort = new AbortController()
    abort.abort(new Error('closed'))
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ABORT_ERR') })
    await expect(pickNativeDirectory(abort.signal, { platform: 'linux', run })).rejects.toThrow('command failed')
  })
})
