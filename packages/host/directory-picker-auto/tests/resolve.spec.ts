import { describe, expect, it } from 'vitest'
import { resolveDirectoryPickerBackend } from '../src/resolve.ts'
import type { DirectoryPickerHostFacts } from '../src/resolve.ts'

/** Baseline facts that resolve to `native`; each case overrides one signal. */
const attended: DirectoryPickerHostFacts = {
  bindHost: '127.0.0.1',
  platform: 'darwin',
  env: {},
}

describe('resolveDirectoryPickerBackend', () => {
  it('resolves native for a loopback bind on a display platform', () => {
    expect(resolveDirectoryPickerBackend(attended)).toBe('native')
    expect(resolveDirectoryPickerBackend({ ...attended, platform: 'win32' })).toBe('native')
  })

  it('resolves browse for an all-interfaces bind regardless of other signals', () => {
    expect(resolveDirectoryPickerBackend({ ...attended, bindHost: '0.0.0.0' })).toBe('browse')
  })

  it('resolves browse under an SSH launch (either env marker)', () => {
    expect(resolveDirectoryPickerBackend({ ...attended, env: { SSH_CONNECTION: '10.0.0.2 55 10.0.0.9 22' } })).toBe('browse')
    expect(resolveDirectoryPickerBackend({ ...attended, env: { SSH_TTY: '/dev/pts/3' } })).toBe('browse')
  })

  it('requires a display session on platforms without an implied one', () => {
    expect(resolveDirectoryPickerBackend({ ...attended, platform: 'linux' })).toBe('browse')
    expect(resolveDirectoryPickerBackend({ ...attended, platform: 'linux', env: { DISPLAY: ':0' } })).toBe('native')
    expect(resolveDirectoryPickerBackend({ ...attended, platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1' } })).toBe('native')
  })

  it('treats blank env exports as unset', () => {
    expect(resolveDirectoryPickerBackend({ ...attended, env: { SSH_CONNECTION: '', SSH_TTY: '' } })).toBe('native')
    expect(resolveDirectoryPickerBackend({ ...attended, platform: 'linux', env: { DISPLAY: '', WAYLAND_DISPLAY: '' } })).toBe('browse')
  })
})
