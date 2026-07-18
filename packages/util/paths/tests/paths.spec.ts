import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  defaultDshHome,
  expandHomePath,
  resolveDshHome,
} from '@deepseek-ai/dsh-paths'

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.dsh')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit DSH home before environment and default locations', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe('/tmp/explicit-dsh')
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })
})
