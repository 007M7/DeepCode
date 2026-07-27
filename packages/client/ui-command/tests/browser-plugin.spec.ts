/**
 * ui-command browser half on a real cordis Context with fake slash/slots
 * faces and real session scopes: the plugin body mounts CommandService as
 * `command`, the popupSelect shell registers into conversation.input.overlay
 * once the conversation seam is up with a per-session inject (sessionId →
 * scope → popupFor; unknown id fails loud), both fold up on fiber disposal
 * (HMR safety), and the service satisfies the frozen CommandServiceContract.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { createScope, scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SlashSource } from '@deepseek-ai/dsh-client-ui-slash/client'
import type { CommandServiceContract } from '../src/client/contract.ts'
import type { PopupSelectInjected } from '../src/client/PopupSelectView.tsx'
import { apply, CommandService, inject } from '../src/client/index.ts'

const sid = (k: string): SessionId => k as SessionId

async function bench() {
  const ctx = new Context()
  const sources = new Map<string, SlashSource>()
  const overlays = new Map<string, { inject: unknown }>()
  ctx.provide('slash', {
    registerSource(src: SlashSource) {
      sources.set(`${src.trigger} ${src.name}`, src)
      return () => { sources.delete(`${src.trigger} ${src.name}`) }
    },
  })
  const scopes = new Map<SessionId, Context>()
  ctx.provide('sessions', {
    scope: (id: SessionId) => scopes.get(id),
    scopeOf: (c: Context) => scopeOf(c),
  })
  ctx.provide('connection', { api: { commands: { list: () => Promise.resolve({ result: { ok: true, value: { commands: [] } } }) } } })
  ctx.provide('slots', {
    register(options: { name: string; id?: string; inject?: unknown }) {
      const key = `${options.name}#${options.id ?? ''}`
      overlays.set(key, { inject: options.inject })
      return () => { overlays.delete(key) }
    },
  })
  ctx.provide('conversation', {})
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const mint = (key: string) => {
    const handle = createScope(ctx, sid(key))
    scopes.set(sid(key), handle.ctx)
    return handle
  }
  return { ctx, fiber, sources, overlays, mint }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slash', 'sessions', 'connection'])
  })

  it('mounts ctx.command, registers the source and the overlay entry, and folds up on disposal', async () => {
    const { ctx, fiber, sources, overlays } = await bench()
    const command = ctx.get('command')
    expect(command).toBeInstanceOf(CommandService)
    // Frozen-contract conformance (compile-time check rides the assignment).
    const contract: CommandServiceContract = command as CommandService
    expect(typeof contract.register).toBe('function')
    expect(typeof contract.popupFor).toBe('function')
    expect([...sources.keys()]).toEqual(['/ command'])
    expect([...overlays.keys()]).toEqual(['conversation.input.overlay#command-popup'])
    await fiber.dispose()
    expect(sources.size).toBe(0)
    expect(overlays.size).toBe(0)
  })

  it('the overlay inject resolves the per-session popup controller by sessionId and fails loud on an unknown id', async () => {
    const { ctx, overlays, mint } = await bench()
    const command = ctx.get('command') as CommandService
    const scope = mint('s1')
    const entry = overlays.get('conversation.input.overlay#command-popup')!
    const injectEntry = entry.inject as (sessionId: SessionId) => PopupSelectInjected
    expect(injectEntry(sid('s1')).popup).toBe(command.popupFor(scope.ctx))
    expect(() => injectEntry(sid('ghost'))).toThrow(/resolved no scope/)
  })
})
