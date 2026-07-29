/**
 * ui-permission browser half on a real cordis Context with fake command/
 * sessions faces: the plugin hangs the /permission popup decoration on the
 * host command; options flatten the session's permissions projection with
 * the current value active and `custom` excluded; availability follows the
 * projection key's presence; a pick submits the /permission line through
 * Session.command and surfaces rejection/unmatched as thrown errors; fiber
 * disposal removes the contribution (HMR safety).
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandDecoration } from '@deepseek-ai/dsh-client-ui-command/client'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission/client'
import { apply, inject } from '../src/client/index.ts'

const sid = (k: string): SessionId => k as SessionId

const SELECT: PermissionSelect = {
  options: [
    { value: 'read-only', name: 'read-only', description: 'Reads only.' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
  ],
  currentValue: 'workspace-write',
}

async function bench() {
  const ctx = new Context()
  let decoration: CommandDecoration | undefined
  ctx.provide('command', {
    decorate(c: CommandDecoration) {
      decoration = c
      return () => { decoration = undefined }
    },
  })
  const values = new Map<SessionId, PermissionSelect>()
  const commands: string[] = []
  let commandResult: { ok: boolean; matched?: boolean } = { ok: true, matched: true }
  const session = (id: SessionId) => ({
    projections: {
      faceOf: (key: string) => ({
        getSnapshot: () => (key === 'permissions' ? values.get(id) : undefined),
        subscribe: () => () => {},
      }),
    },
    command: (line: string) => {
      commands.push(line)
      return Promise.resolve(commandResult.ok
        ? { ok: true as const, value: { matched: commandResult.matched ?? true } }
        : { ok: false as const, error: { code: 'internal', message: 'boom' } })
    },
  })
  ctx.provide('sessions', {
    binding: (id: SessionId) => (values.has(id) ? { sessionId: id, session: session(id) } : undefined),
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx, fiber, values, commands,
    setResult: (r: { ok: boolean; matched?: boolean }) => { commandResult = r },
    decoration: () => decoration,
  }
}

describe('ui-permission browser plugin', () => {
  it('hangs the /permission popup decoration on the host command', async () => {
    const b = await bench()
    const c = b.decoration()!
    expect(c.name).toBe('permission')
    expect(c.ui.kind).toBe('popupSelect')
  })

  it('availability follows the projection key; options mark the current value active and exclude custom', async () => {
    const b = await bench()
    const c = b.decoration()!
    const proj = { sessionId: sid('s1') }
    expect(c.available(proj)).toBe(false)
    b.values.set(sid('s1'), { ...SELECT, options: [...SELECT.options, { value: 'custom', name: 'Custom' }], currentValue: 'custom' })
    expect(c.available(proj)).toBe(true)
    const options = await c.ui.options(proj, new AbortController().signal)
    expect(options.map(option => option.id)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(options.every(option => option.active !== true)).toBe(true)
    b.values.set(sid('s1'), SELECT)
    const again = await c.ui.options(proj, new AbortController().signal)
    expect(again.find(option => option.id === 'workspace-write')?.active).toBe(true)
    expect(again.find(option => option.id === 'read-only')?.detail).toBe('Reads only.')
    // Kebab-case names title-case; non-kebab host-configured names pass through.
    expect(again.map(option => option.label)).toEqual(['Read Only', 'Workspace Write', 'Danger Full Access'])
    b.values.set(sid('s1'), { ...SELECT, options: [{ value: 'plain', name: 'Ask Every Time' }] })
    const passthrough = await c.ui.options(proj, new AbortController().signal)
    expect(passthrough[0]?.label).toBe('Ask Every Time')
    // A projection that vanished between availability and open throws.
    expect(() => c.ui.options({ sessionId: sid('ghost') }, new AbortController().signal))
      .toThrow(/not available on this host/)
  })

  it('a pick submits the /permission line; rejection and unmatched throw', async () => {
    const b = await bench()
    const c = b.decoration()!
    const proj = { sessionId: sid('s1') }
    b.values.set(sid('s1'), SELECT)
    await c.ui.onSelect({ id: 'danger-full-access', label: 'danger-full-access' }, proj)
    expect(b.commands).toEqual(['/permission danger-full-access'])
    b.setResult({ ok: false })
    await expect(c.ui.onSelect({ id: 'read-only', label: 'read-only' }, proj)).rejects.toThrow(/permission switch failed/)
    b.setResult({ ok: true, matched: false })
    await expect(c.ui.onSelect({ id: 'read-only', label: 'read-only' }, proj)).rejects.toThrow(/no \/permission command/)
    // An unmaterialized session throws before any submit.
    await expect(c.ui.onSelect({ id: 'read-only', label: 'read-only' }, { sessionId: sid('ghost') }))
      .rejects.toThrow(/not materialized/)
  })

  it('disposal removes the decoration (HMR safety)', async () => {
    const b = await bench()
    expect(b.decoration()).toBeDefined()
    await b.fiber.dispose()
    expect(b.decoration()).toBeUndefined()
  })
})
