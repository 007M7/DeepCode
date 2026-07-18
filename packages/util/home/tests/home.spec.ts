import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-home'

afterEach(() => vi.unstubAllEnvs())

describe('resolveDshHome', () => {
  it('prefers an explicit configured path and resolves it absolutely', () => {
    vi.stubEnv(DSH_HOME_ENV, './environment-home')

    expect(resolveDshHome('./configured-home')).toBe(resolve('./configured-home'))
  })

  it('uses DSH_HOME when no configured path is supplied', () => {
    vi.stubEnv(DSH_HOME_ENV, './environment-home')

    expect(resolveDshHome()).toBe(resolve('./environment-home'))
  })

  it('defaults to the .dsh directory under the user home', () => {
    vi.stubEnv(DSH_HOME_ENV, undefined)

    expect(resolveDshHome()).toBe(join(homedir(), '.dsh'))
  })
})
