import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

const sid = (s: string) => s as SessionId
const comp = (name: string) => {
  const fc = () => null
  fc.displayName = name
  return fc as unknown as import('react').FC<ToolViewProps>
}

describe('ToolViewRegistry', () => {
  it('resolves a global registration for any session', () => {
    const reg = new ToolViewRegistry()
    const bash = comp('Bash')
    reg.register('bash', bash)
    expect(reg.resolve('bash', sid('a'))?.component).toBe(bash)
    expect(reg.resolve('bash', sid('b'))?.component).toBe(bash)
    expect(reg.resolve('read', sid('a'))).toBeUndefined()
  })

  it('prefers a matching scope filter over the global registration', () => {
    const reg = new ToolViewRegistry()
    const global = comp('Global')
    const swarm = comp('Swarm')
    reg.register('bash', global)
    reg.register('bash', swarm, { scope: id => id === sid('swarm-1') })
    expect(reg.resolve('bash', sid('swarm-1'))?.component).toBe(swarm)
    expect(reg.resolve('bash', sid('plain'))?.component).toBe(global)
  })

  it('later registration wins within the same tier, scoped and global', () => {
    const reg = new ToolViewRegistry()
    const s1 = comp('S1')
    const s2 = comp('S2')
    const g1 = comp('G1')
    const g2 = comp('G2')
    reg.register('bash', g1)
    reg.register('bash', s1, { scope: () => true })
    reg.register('bash', s2, { scope: () => true })
    reg.register('bash', g2)
    expect(reg.resolve('bash', sid('x'))?.component).toBe(s2)
    const scopeless = new ToolViewRegistry()
    scopeless.register('bash', g1)
    scopeless.register('bash', g2)
    expect(scopeless.resolve('bash', sid('x'))?.component).toBe(g2)
  })

  it('a non-matching scope filter falls through to global, then undefined', () => {
    const reg = new ToolViewRegistry()
    const scoped = comp('Scoped')
    reg.register('bash', scoped, { scope: () => false })
    expect(reg.resolve('bash', sid('x'))).toBeUndefined()
    const global = comp('Global')
    reg.register('bash', global)
    expect(reg.resolve('bash', sid('x'))?.component).toBe(global)
  })

  it('disposer removes exactly its registration and is idempotent', () => {
    const reg = new ToolViewRegistry()
    const g = comp('G')
    const s = comp('S')
    const off = reg.register('bash', s, { scope: () => true })
    reg.register('bash', g)
    off()
    off()
    expect(reg.resolve('bash', sid('x'))?.component).toBe(g)
  })

  it('unregistering the last entry resolves undefined (GenericToolCard fallback)', () => {
    const reg = new ToolViewRegistry()
    const off = reg.register('bash', comp('B'))
    off()
    expect(reg.resolve('bash', sid('x'))).toBeUndefined()
  })

  it('carries the inject factory through resolve', () => {
    const reg = new ToolViewRegistry()
    const inject = () => ({})
    reg.register('bash', comp('B'), { inject })
    expect(reg.resolve('bash', sid('x'))?.inject).toBe(inject)
    reg.register('read', comp('R'))
    expect('inject' in reg.resolve('read', sid('x'))!).toBe(false)
  })

  it('notifies subscribers and bumps the version on register and dispose', () => {
    const reg = new ToolViewRegistry()
    const fn = vi.fn()
    const unsub = reg.subscribe(fn)
    const v0 = reg.getVersion()
    const off = reg.register('bash', comp('B'))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(reg.getVersion()).toBeGreaterThan(v0)
    off()
    expect(fn).toHaveBeenCalledTimes(2)
    unsub()
    reg.register('read', comp('R'))
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
