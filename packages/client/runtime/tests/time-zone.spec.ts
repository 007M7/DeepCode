import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvedClientTimeZone } from '../src/client/time-zone.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('browser time zone', () => {
  it('returns the runtime-resolved zone', () => {
    expect(resolvedClientTimeZone()).toBe(
      new Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
  })

  it('fails loud when the runtime exposes no zone', () => {
    const options = new Intl.DateTimeFormat().resolvedOptions()
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...options,
      timeZone: '',
    })

    expect(() => resolvedClientTimeZone()).toThrow('browser time zone is unavailable')
  })
})
