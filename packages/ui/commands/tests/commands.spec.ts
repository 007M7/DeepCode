import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import CommandService, { parseCommand, type CommandDefinition } from '@deepseek-ai/dsh-commands'

function command(name: string, text = `ran:${name}`): CommandDefinition {
  return {
    name,
    description: `command ${name}`,
    handler: () => ({ kind: 'success', text }),
  }
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(CommandService)
  return ctx
}

/** Mint a scope whose key is sufficient for registry lookup and invocation. */
async function mintAgentScope(ctx: Context, name: string): Promise<{ scope: Scope; agent: Agent }> {
  const agent = { id: name as SessionId } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['commands'] }))
  return { scope, agent }
}

describe('parseCommand()', () => {
  it.each([
    ['/goal', { name: 'goal', rawInput: '' }],
    ['/goal create the thing', { name: 'goal', rawInput: ' create the thing' }],
    ['/goal\ncreate the thing', { name: 'goal', rawInput: '\ncreate the thing' }],
    ['/goal_name-2\t x ', { name: 'goal_name-2', rawInput: '\t x ' }],
  ] as const)('parses %j without normalizing trailing input', (line, expected) => {
    expect(parseCommand(line)).toEqual(expected)
  })

  it.each(['goal', ' /goal', '/', '/Goal', '/goal/path', '/goal🔥'])('rejects non-command boundary %j', (line) => {
    expect(parseCommand(line)).toBeUndefined()
  })
})

describe('CommandService', () => {
  it('lists immutable global descriptors with input metadata', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const definition: CommandDefinition = {
      name: 'inspect',
      description: 'Inspect state',
      input: { hint: '<target>' },
      handler: () => ({ kind: 'success' }),
    }
    ctx.commands.register(definition)

    const listed = ctx.commands.list(agent)
    expect(listed).toEqual([{
      name: 'inspect',
      description: 'Inspect state',
      input: { hint: '<target>' },
    }])
    expect(Object.isFrozen(listed)).toBe(true)
    expect(Object.isFrozen(listed[0])).toBe(true)
    expect(Object.isFrozen(listed[0]?.input)).toBe(true)
    expect(ctx.commands.find(agent, 'inspect')).toMatchObject({ name: 'inspect' })
    expect(ctx.commands.find(agent, 'missing')).toBeUndefined()
  })

  it('sorts distinct effective command names', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(command('zeta'))
    ctx.commands.register(command('alpha'))
    ctx.commands.register(command('middle'))
    expect(ctx.commands.list(agent).map(item => item.name)).toEqual(['alpha', 'middle', 'zeta'])
  })

  it('uses agent-scoped shadows and removes them with their scope', async () => {
    const ctx = await mount()
    const { scope, agent } = await mintAgentScope(ctx, 'a')
    const other = { id: 'other' as SessionId } as Agent
    ctx.commands.register(command('shared', 'global'))
    scope.ctx.commands.register(command('shared', 'scoped'))

    expect(ctx.commands.list(agent).map(item => item.name)).toEqual(['shared'])
    expect(ctx.commands.find(agent, 'shared')?.handler).toBeDefined()
    expect(ctx.commands.list(other).map(item => item.name)).toEqual(['shared'])
    expect(await ctx.commands.execute(agent, '/shared', new AbortController().signal))
      .toEqual({ kind: 'success', text: 'scoped' })

    await scope.dispose()
    expect((await ctx.commands.execute(agent, '/shared', new AbortController().signal))?.text).toBe('global')
  })

  it('rejects duplicates within one layer while allowing a scoped shadow', async () => {
    const ctx = await mount()
    const { scope } = await mintAgentScope(ctx, 'a')
    ctx.commands.register(command('same'))
    expect(() => ctx.commands.register(command('same'))).toThrow(/agent\.ctx/)
    scope.ctx.commands.register(command('same'))
    expect(() => scope.ctx.commands.register(command('same'))).toThrow(/already registered in this scope/)
  })

  it('notifies on registration and disposal while containing broken observers', async () => {
    const ctx = await mount()
    const changed = vi.fn()
    ctx.on('commands/change', changed)
    const dispose = ctx.commands.register(command('live'))
    dispose()
    dispose()
    expect(changed).toHaveBeenCalledTimes(2)

    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.on('commands/change', () => { throw new Error('observer threw') })
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- exercises rejected-listener containment
    ctx.on('commands/change', () => Promise.reject(new Error('observer rejected')))
    const afterFailures = vi.fn()
    ctx.on('commands/change', afterFailures)
    const removeContained = ctx.commands.register(command('contained'))
    const { agent } = await mintAgentScope(ctx, 'a')
    expect(ctx.commands.find(agent, 'contained')).toBeDefined()
    expect(afterFailures).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('commands/change listener threw: Error: observer threw')
      expect(warn).toHaveBeenCalledWith('commands/change listener rejected: Error: observer rejected')
    })
    removeContained()
    expect(ctx.commands.find(agent, 'contained')).toBeUndefined()
    expect(afterFailures).toHaveBeenCalledTimes(2)
  })

  it('rejects non-string descriptions and input hints with boundary diagnostics', async () => {
    const ctx = await mount()
    expect(() => ctx.commands.register({
      ...command('description-type'),
      description: undefined,
    } as unknown as CommandDefinition)).toThrow('command "description-type" description must be a string')
    expect(() => ctx.commands.register({
      ...command('hint-type'),
      input: { hint: 42 },
    } as unknown as CommandDefinition)).toThrow('command "hint-type" input hint must be a string')
    expect(() => ctx.commands.register({
      ...command('input-type'),
      input: null,
    } as unknown as CommandDefinition)).toThrow('command "input-type" input hint must be a string')
  })

  it('passes exact invocation context and detaches valid handler results', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const seen = vi.fn(() => ({ kind: 'success' as const, text: 'ok' }))
    ctx.commands.register({ name: 'run', description: 'Run it', handler: seen })
    const controller = new AbortController()

    const result = await ctx.commands.execute(agent, '/run  untouched ', controller.signal)

    expect(result).toEqual({ kind: 'success', text: 'ok' })
    expect(Object.isFrozen(result)).toBe(true)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({
      agent,
      rawInput: '  untouched ',
      signal: controller.signal,
    }))
    await expect(ctx.commands.execute(agent, 'run', controller.signal)).resolves.toBeUndefined()
    await expect(ctx.commands.execute(agent, '/missing', controller.signal)).resolves.toBeUndefined()
  })

  it('stops awaiting an aborted handler and handles an already-aborted signal', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    let release!: (result: { kind: 'success'; text: string }) => void
    ctx.commands.register({
      name: 'wait',
      description: 'Wait',
      handler: () => new Promise((resolve) => { release = resolve }),
    })
    const running = new AbortController()
    const promise = ctx.commands.execute(agent, '/wait', running.signal)
    running.abort('operator cancelled command')
    await expect(promise).rejects.toThrow('operator cancelled command')
    release({ kind: 'success', text: 'late' })

    const already = new AbortController()
    already.abort(new Error('already gone'))
    await expect(ctx.commands.execute(agent, '/wait', already.signal)).rejects.toThrow('already gone')

    const defaultReason = new AbortController()
    defaultReason.abort({ source: 'test' })
    await expect(ctx.commands.execute(agent, '/wait', defaultReason.signal)).rejects.toThrow('command aborted')
  })

  it('propagates an asynchronously rejected handler', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({
      name: 'reject',
      description: 'Reject',
      handler: () => Promise.reject(new Error('handler rejected')),
    })
    await expect(ctx.commands.execute(agent, '/reject', new AbortController().signal))
      .rejects.toThrow('handler rejected')

    ctx.commands.register({
      name: 'reject-value',
      description: 'Reject a non-Error value',
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise untyped plugin normalization
      handler: () => Promise.reject('not an Error'),
    })
    await expect(ctx.commands.execute(agent, '/reject-value', new AbortController().signal))
      .rejects.toThrow('command handler rejected with a non-Error value: not an Error')

    const hostile = { toString(): string { throw new Error('cannot render') } }
    ctx.commands.register({
      name: 'reject-hostile',
      description: 'Reject an unrenderable value',
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercise hostile plugin normalization
      handler: () => Promise.reject(hostile),
    })
    await expect(ctx.commands.execute(agent, '/reject-hostile', new AbortController().signal))
      .rejects.toMatchObject({
        message: 'command handler rejected with a non-Error value: <unrenderable thrown value>',
        cause: hostile,
      })
  })

  it('observes an abort triggered synchronously inside the handler', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const controller = new AbortController()
    ctx.commands.register({
      name: 'self-abort',
      description: 'Abort before returning',
      handler: () => {
        controller.abort('aborted in handler')
        return { kind: 'success' }
      },
    })
    await expect(ctx.commands.execute(agent, '/self-abort', controller.signal))
      .rejects.toThrow('aborted in handler')
  })

  it('returns a detached expected-error result', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({
      name: 'denied',
      description: 'Denied',
      handler: () => ({ kind: 'error', text: 'not now' }),
    })
    const result = await ctx.commands.execute(agent, '/denied', new AbortController().signal)
    expect(result).toEqual({ kind: 'error', text: 'not now' })
    expect(Object.isFrozen(result)).toBe(true)

    ctx.commands.register({
      name: 'silent',
      description: 'No output',
      handler: () => ({ kind: 'success' }),
    })
    const silent = await ctx.commands.execute(agent, '/silent', new AbortController().signal)
    expect(silent).toEqual({ kind: 'success' })
    expect(Object.isFrozen(silent)).toBe(true)
  })

  it.each([
    [{ ...command('Bad') }, /command name/],
    [{ ...command('empty-description'), description: ' ' }, /description/],
    [{ ...command('empty-hint'), input: { hint: '' } }, /input hint/],
    [{ ...command('bad-handler'), handler: undefined }, /handler/],
  ] as const)('rejects invalid definition %#', async (definition, expected) => {
    const ctx = await mount()
    expect(() => ctx.commands.register(definition as unknown as CommandDefinition)).toThrow(expected)
  })

  it.each([
    [undefined, /CommandResult/],
    [null, /CommandResult/],
    [{}, /CommandResult/],
    [{ kind: 'success', text: 1 }, /success text/],
    [{ kind: 'error', text: '' }, /error text/],
    [{ kind: 'error', text: 1 }, /error text/],
    [{ kind: 'future', text: 'x' }, /unknown result kind/],
  ] as const)('rejects malformed handler result %j', async (output, expected) => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    ctx.commands.register({
      name: 'broken',
      description: 'Broken',
      handler: () => output as never,
    })
    await expect(ctx.commands.execute(agent, '/broken', new AbortController().signal)).rejects.toThrow(expected)
  })
})
