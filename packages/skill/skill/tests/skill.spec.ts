import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import SkillService, { type SkillCandidate, type SkillDefinition, type SkillLookupOptions, type SkillProvider } from '@deepseek-ai/dsh-skill'

function memorySkill(name: string, description: string, rank: number, body = `${name} body.`): SkillCandidate {
  return {
    name,
    description,
    provider: 'memory',
    source: 'memory',
    rank,
    locator: { content: body },
  }
}

class MemoryProvider implements SkillProvider {
  readonly name = 'memory'
  listCalls = 0

  constructor(private candidates: SkillCandidate[]) {}

  async list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
    this.listCalls += 1
    return this.candidates
  }

  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as { content: string }
    return { ...candidate, content: locator.content }
  }

  replace(candidates: SkillCandidate[]): void {
    this.candidates = candidates
  }
}

describe('SkillService registry', () => {
  it('registers providers, resolves duplicates first-wins, and disposes providers', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    const provider = new MemoryProvider([
      memorySkill('z-skill', 'Z skill', 20),
      memorySkill('a-skill', 'A skill', 10),
      memorySkill('shadowed', 'Lower priority', 20),
    ])
    const overrideProvider: SkillProvider = {
      name: 'override',
      async list() {
        return [{
          name: 'shadowed',
          description: 'Higher priority',
          provider: 'override',
          source: 'override',
          rank: 5,
          locator: { content: 'Override body.' },
        }]
      },
      async get(candidate) {
        return { ...candidate, content: (candidate.locator as { content: string }).content }
      },
    }
    const disposeMemory = ctx.skills.registerProvider(provider)
    ctx.skills.registerProvider(overrideProvider)

    expect((await ctx.skills.list()).map(skill => [skill.name, skill.description, skill.provider])).toEqual([
      ['a-skill', 'A skill', 'memory'],
      ['shadowed', 'Higher priority', 'override'],
      ['z-skill', 'Z skill', 'memory'],
    ])
    expect((await ctx.skills.get('shadowed'))?.content).toBe('Override body.')
    const sameRankProvider: SkillProvider = {
      name: 'same-rank',
      async list() {
        return [{
          name: 'same-rank-skill',
          description: 'Same rank',
          provider: 'same-rank',
          source: 'same-rank',
          rank: 10,
          locator: { content: 'Same rank body.' },
        }]
      },
      async get(candidate) {
        return { ...candidate, content: (candidate.locator as { content: string }).content }
      },
    }
    ctx.skills.registerProvider(sameRankProvider)
    expect((await ctx.skills.list()).find(skill => skill.name === 'same-rank-skill')?.provider).toBe('same-rank')
    await expect(ctx.plugin({
      name: 'duplicate-memory',
      inject: ['skills'],
      apply(pluginCtx: Context) {
        pluginCtx.skills.registerProvider(new MemoryProvider([]))
      },
    })).rejects.toThrow('already registered')
    expect(() => ctx.skills.registerProvider({
      name: 'runtime',
      async list() {
        return []
      },
      async get() {
        return undefined
      },
    })).toThrow('reserved')

    await disposeMemory()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['same-rank-skill', 'shadowed'])
  })

  it('snapshots a provider registration so caller mutation cannot corrupt HMR cleanup', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    const candidate: SkillCandidate = {
      name: 'stable-skill',
      description: 'Stable skill',
      provider: 'stable-provider',
      source: 'test',
      rank: 1,
      locator: 'original',
    }
    const originalList = vi.fn(() => Promise.resolve([candidate]))
    const originalGet = vi.fn((listed: SkillCandidate) => Promise.resolve<SkillDefinition>({
      ...listed,
      content: 'Original body.',
    }))
    const provider: SkillProvider = {
      name: 'stable-provider',
      list: originalList,
      get: originalGet,
    }
    const added: SkillProvider[] = []
    const removed: string[] = []
    ctx.on('skill/provider-added', (registered) => { added.push(registered) })
    ctx.on('skill/provider-removed', (name) => { removed.push(name) })
    const owner = await ctx.plugin({
      name: 'mutable-provider-owner',
      inject: ['skills'],
      apply(pluginCtx: Context) {
        pluginCtx.skills.registerProvider(provider)
      },
    })

    provider.name = 'mutated-provider'
    const replacementList = vi.fn(() => Promise.resolve([]))
    const replacementGet = vi.fn(() => Promise.resolve(undefined))
    provider.list = replacementList
    provider.get = replacementGet

    expect(added).toHaveLength(1)
    expect(added[0]).not.toBe(provider)
    expect(added[0]?.name).toBe('stable-provider')
    expect(Object.isFrozen(added[0])).toBe(true)
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['stable-skill'])
    expect((await ctx.skills.get('stable-skill'))?.content).toBe('Original body.')
    expect(originalList).toHaveBeenCalledOnce()
    expect(originalGet).toHaveBeenCalledOnce()
    expect(replacementList).not.toHaveBeenCalled()
    expect(replacementGet).not.toHaveBeenCalled()

    await owner.dispose()
    expect(removed).toEqual(['stable-provider'])
    expect(await ctx.skills.list()).toEqual([])
    const replacement = new MemoryProvider([])
    Object.defineProperty(replacement, 'name', { value: 'stable-provider' })
    expect(() => ctx.skills.registerProvider(replacement)).not.toThrow()
  })

  it('rejects malformed provider and candidate scalar fields without freezing caller objects', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    const badProviderName = { value: 'object-provider' }
    expect(() => ctx.skills.registerProvider({
      name: badProviderName as unknown as string,
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
    })).toThrow('skill provider name must be a string')
    expect(Object.isFrozen(badProviderName)).toBe(false)
    expect(() => ctx.skills.registerProvider({
      name: 'bad-list',
      list: { bind() {} } as unknown as SkillProvider['list'],
      get: () => Promise.resolve(undefined),
    })).toThrow('list must be a function')
    expect(() => ctx.skills.registerProvider({
      name: 'bad-get',
      list: () => Promise.resolve([]),
      get: { bind() {} } as unknown as SkillProvider['get'],
    })).toThrow('get must be a function')

    const badDescription = { value: 'object-description' }
    ctx.skills.registerProvider({
      name: 'bad-candidate',
      list: () => Promise.resolve([{
        ...memorySkill('bad-candidate', 'placeholder', 1),
        provider: 'bad-candidate',
        description: badDescription as unknown as string,
        disableModelInvocation: 'false' as unknown as boolean,
      }]),
      get: () => Promise.resolve(undefined),
    })
    await expect(ctx.skills.list()).rejects.toThrow('non-string description')
    expect(Object.isFrozen(badDescription)).toBe(false)

    const badBoolean = new Context()
    await badBoolean.plugin(SkillService)
    badBoolean.skills.registerProvider({
      name: 'bad-boolean',
      list: () => Promise.resolve([{
        ...memorySkill('bad-boolean', 'Bad boolean', 1),
        provider: 'bad-boolean',
        disableModelInvocation: 'false' as unknown as boolean,
      }]),
      get: () => Promise.resolve(undefined),
    })
    await expect(badBoolean.skills.list()).rejects.toThrow('non-boolean disableModelInvocation')
  })

  it('rejects non-array provider results and every malformed candidate scalar', async () => {
    const badList = new Context()
    await badList.plugin(SkillService)
    badList.skills.registerProvider({
      name: 'non-array-list',
      list: () => Promise.resolve({} as unknown as SkillCandidate[]),
      get: () => Promise.resolve(undefined),
    })
    await expect(badList.skills.list()).rejects.toThrow('list() must return an array')

    const cases: { patch: Partial<SkillCandidate>; expected: string }[] = [
      { patch: { name: { value: 'candidate' } as unknown as string }, expected: 'non-string skill name' },
      { patch: { whenToUse: 1 as unknown as string }, expected: 'non-string whenToUse' },
      { patch: { source: { value: 'source' } as unknown as string }, expected: 'non-string source' },
      { patch: { rank: '1' as unknown as number }, expected: 'invalid rank' },
      { patch: { provider: { value: 'provider' } as unknown as string }, expected: 'non-string provider' },
      { patch: { path: 1 as unknown as string }, expected: 'non-string path' },
    ]
    for (const [index, { patch, expected }] of cases.entries()) {
      const ctx = new Context()
      await ctx.plugin(SkillService)
      const providerName = `candidate-provider-${index}`
      const candidate = {
        name: `candidate-${index}`,
        description: 'Candidate',
        whenToUse: 'Use this candidate.',
        disableModelInvocation: false,
        provider: providerName,
        source: 'test',
        rank: 1,
        locator: 'candidate',
        path: '/skills/candidate/SKILL.md',
        ...patch,
      } as SkillCandidate
      ctx.skills.registerProvider({
        name: providerName,
        list: () => Promise.resolve([candidate]),
        get: () => Promise.resolve(undefined),
      })

      await expect(ctx.skills.list()).rejects.toThrow(expected)
    }
  })

  it('snapshots lookup options before asynchronous discovery and loading', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const listCwds: (string | undefined)[] = []
    const getCwds: (string | undefined)[] = []
    ctx.skills.registerProvider({
      name: 'contextual',
      async list(options) {
        listCwds.push(options.cwd)
        await gate
        const name = options.cwd === '/workspace/a' ? 'skill-a' : 'skill-b'
        return [
          { name, description: name, provider: 'contextual', source: 'test', rank: 1, locator: name },
          { name: 'vanished', description: 'Vanished', provider: 'contextual', source: 'test', rank: 2, locator: 'vanished' },
        ]
      },
      async get(candidate, options) {
        getCwds.push(options.cwd)
        if (candidate.name === 'vanished') return undefined
        return { ...candidate, content: `${options.cwd}:${candidate.name}` }
      },
    })

    const listOptions: { cwd: string | undefined } = { cwd: '/workspace/a' }
    const pending = ctx.skills.list(listOptions)
    listOptions.cwd = '/workspace/b'
    release?.()

    expect((await pending).map(skill => skill.name)).toEqual(['skill-a', 'vanished'])
    expect((await ctx.skills.list({ cwd: '/workspace/a' })).map(skill => skill.name)).toEqual(['skill-a', 'vanished'])
    expect(listCwds).toEqual(['/workspace/a'])

    const getOptions: { cwd: string | undefined } = { cwd: '/workspace/a' }
    const loading = ctx.skills.get('skill-a', getOptions)
    getOptions.cwd = '/workspace/b'
    expect((await loading)?.content).toBe('/workspace/a:skill-a')
    expect(await ctx.skills.get('vanished', { cwd: '/workspace/a' })).toBeUndefined()
    expect(getCwds).toEqual(['/workspace/a', '/workspace/a'])
  })

  it('rechecks cancellation after cached discovery before provider loading', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    let getCalls = 0
    ctx.skills.registerProvider({
      name: 'cached',
      async list() {
        return [{
          name: 'cached-skill',
          description: 'Cached skill',
          provider: 'cached',
          source: 'test',
          rank: 1,
          locator: 'cached',
        }]
      },
      async get(candidate) {
        getCalls += 1
        return { ...candidate, content: 'Cached body.' }
      },
    })
    await ctx.skills.list({ cwd: '/workspace/cache' })
    const controller = new AbortController()
    const reason = new Error('cancelled after cached discovery')

    const pending = ctx.skills.get('cached-skill', {
      cwd: '/workspace/cache',
      signal: controller.signal,
    })
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(getCalls).toBe(0)
  })

  it('stops waiting for cached provider loading when a hostile abort reason fires', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    let markStarted: (() => void) | undefined
    let release: (() => void) | undefined
    let seenSignal: AbortSignal | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const held = new Promise<SkillDefinition>((resolve) => {
      release = () => {
        resolve({
          name: 'held-skill',
          description: 'Held skill',
          provider: 'held',
          source: 'test',
          content: 'Held body.',
        })
      }
    })
    ctx.skills.registerProvider({
      name: 'held',
      async list() {
        return [{
          name: 'held-skill',
          description: 'Held skill',
          provider: 'held',
          source: 'test',
          rank: 1,
          locator: 'held',
        }]
      },
      get(_candidate, options) {
        seenSignal = options.signal
        markStarted?.()
        return held
      },
    })
    await ctx.skills.list({ cwd: '/workspace/cache' })
    const controller = new AbortController()
    const hostileReason = {
      [Symbol.toPrimitive]() {
        throw new Error('abort reason coercion failed')
      },
    }
    const pending = ctx.skills.get('held-skill', {
      cwd: '/workspace/cache',
      signal: controller.signal,
    })
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => error instanceof Error && error.message === '[unrenderable thrown value]'
        ? 'aborted'
        : 'other-error',
    )
    await started
    controller.abort(hostileReason)

    const settled = await Promise.race([
      outcome,
      new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 25)),
    ])
    release?.()
    await pending.catch(() => undefined)

    expect(seenSignal).toBe(controller.signal)
    expect(settled).toBe('aborted')
  })

  it('detaches cached candidates and loaded definitions while preserving locator identity', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    const locator = { id: 'provider-owned' }
    const candidate: SkillCandidate = {
      name: 'stable-skill',
      description: 'Stable description',
      whenToUse: 'When stability matters.',
      disableModelInvocation: false,
      provider: 'detached',
      source: 'test',
      resourceBase: { kind: 'opaque', description: 'candidate resources' },
      rank: 1,
      locator,
      path: '/skills/stable/SKILL.md',
      metadata: { owner: 'candidate' },
    }
    const definition: SkillDefinition = {
      name: 'stable-skill',
      description: 'Stable description',
      whenToUse: 'When stability matters.',
      disableModelInvocation: false,
      provider: 'detached',
      source: 'test',
      resourceBase: { kind: 'opaque', description: 'definition resources' },
      path: '/skills/stable/SKILL.md',
      metadata: { owner: 'definition' },
      content: 'Stable body.',
    }
    let listCalls = 0
    let received: SkillCandidate | undefined
    ctx.skills.registerProvider({
      name: 'detached',
      async list() {
        listCalls += 1
        return [candidate]
      },
      async get(loaded) {
        received = loaded
        return definition
      },
    })

    const first = await ctx.skills.list()
    candidate.name = 'Bad_Name'
    candidate.description = ''
    if (candidate.resourceBase?.kind === 'opaque') candidate.resourceBase.description = 'mutated candidate'
    if (candidate.metadata) candidate.metadata.owner = 'mutated candidate'
    if (first[0]?.resourceBase?.kind === 'opaque') first[0].resourceBase.description = 'mutated summary'

    const second = await ctx.skills.list()
    expect(second).toEqual([expect.objectContaining({
      name: 'stable-skill',
      description: 'Stable description',
      resourceBase: { kind: 'opaque', description: 'candidate resources' },
    })])
    expect(listCalls).toBe(1)

    const loaded = await ctx.skills.get('stable-skill')
    expect(received).not.toBe(candidate)
    expect(received?.locator).toBe(locator)
    expect(received).toMatchObject({
      name: 'stable-skill',
      description: 'Stable description',
      resourceBase: { kind: 'opaque', description: 'candidate resources' },
      metadata: { owner: 'candidate' },
    })
    expect(loaded).not.toBe(definition)
    if (loaded?.resourceBase?.kind === 'opaque') loaded.resourceBase.description = 'mutated definition output'
    if (loaded?.metadata) loaded.metadata.owner = 'mutated definition output'

    expect(await ctx.skills.get('stable-skill')).toMatchObject({
      resourceBase: { kind: 'opaque', description: 'definition resources' },
      metadata: { owner: 'definition' },
    })
    expect(definition).toMatchObject({
      resourceBase: { kind: 'opaque', description: 'definition resources' },
      metadata: { owner: 'definition' },
    })
  })

  it('detaches runtime registrations and every public resource view', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    const resourceBase = { kind: 'opaque' as const, description: 'runtime resources' }
    const metadata = { owner: 'runtime' }
    ctx.skills.register({
      name: 'runtime-skill',
      description: 'Runtime',
      whenToUse: 'When runtime data is needed.',
      disableModelInvocation: false,
      source: 'runtime',
      resourceBase,
      metadata,
      content: 'Runtime body.',
    })
    ctx.skills.register({
      name: 'z-runtime',
      description: 'Second runtime skill',
      source: 'runtime',
      content: 'Second runtime body.',
    })
    resourceBase.description = 'mutated registration'
    metadata.owner = 'mutated registration'

    const listed = await ctx.skills.list()
    const loaded = await ctx.skills.get('runtime-skill')
    expect(listed[0]?.resourceBase).toEqual({ kind: 'opaque', description: 'runtime resources' })
    expect(loaded?.metadata).toEqual({ owner: 'runtime' })
    if (listed[0]?.resourceBase?.kind === 'opaque') listed[0].resourceBase.description = 'mutated list output'
    if (loaded?.resourceBase?.kind === 'opaque') loaded.resourceBase.description = 'mutated get output'
    if (loaded?.metadata) loaded.metadata.owner = 'mutated get output'

    expect((await ctx.skills.list())[0]?.resourceBase).toEqual({ kind: 'opaque', description: 'runtime resources' })
    expect(await ctx.skills.get('runtime-skill')).toMatchObject({
      resourceBase: { kind: 'opaque', description: 'runtime resources' },
      metadata: { owner: 'runtime' },
    })
  })

  it('rejects malformed runtime and loaded-definition scalar fields without freezing them', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    const runtimeDescription = { value: 'runtime-description' }
    expect(() => ctx.skills.register({
      name: 'bad-runtime',
      description: runtimeDescription as unknown as string,
      source: 'runtime',
      content: 'body',
    })).toThrow('description must be a string')
    expect(Object.isFrozen(runtimeDescription)).toBe(false)
    expect(() => ctx.skills.register({
      name: 'bad-runtime-boolean',
      description: 'Runtime',
      disableModelInvocation: 'false' as unknown as boolean,
      source: 'runtime',
      content: 'body',
    })).toThrow('disableModelInvocation must be a boolean')
    expect(() => ctx.skills.register({
      name: 'bad-runtime-provider',
      description: 'Runtime',
      source: 'runtime',
      provider: null as unknown as string,
      content: 'body',
    })).toThrow('provider must be a string')

    const loadedContent = { value: 'loaded-content' }
    ctx.skills.registerProvider({
      name: 'bad-definition',
      list: () => Promise.resolve([{
        name: 'bad-definition',
        description: 'Candidate',
        provider: 'bad-definition',
        source: 'test',
        rank: 1,
        locator: 'bad-definition',
      }]),
      get: candidate => Promise.resolve({
        ...candidate,
        content: loadedContent as unknown as string,
      }),
    })
    await expect(ctx.skills.get('bad-definition')).rejects.toThrow('content must be a string')
    expect(Object.isFrozen(loadedContent)).toBe(false)
  })

  it('rejects every other malformed runtime scalar', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    type Registration = Parameters<typeof ctx.skills.register>[0]
    const valid: Registration = {
      name: 'runtime-validation',
      description: 'Runtime validation',
      whenToUse: 'Use this runtime skill.',
      disableModelInvocation: false,
      source: 'runtime',
      provider: 'runtime-validation',
      content: 'Runtime body.',
      path: '/skills/runtime-validation/SKILL.md',
    }
    const cases: { patch: Partial<Registration>; expected: string }[] = [
      { patch: { name: { value: 'runtime' } as unknown as string }, expected: 'runtime skill name must be a string' },
      { patch: { whenToUse: 1 as unknown as string }, expected: 'whenToUse must be a string' },
      { patch: { source: { value: 'source' } as unknown as string }, expected: 'source must be a string' },
      { patch: { content: { value: 'content' } as unknown as string }, expected: 'content must be a string' },
      { patch: { path: 1 as unknown as string }, expected: 'path must be a string' },
    ]
    for (const { patch, expected } of cases) {
      expect(() => ctx.skills.register({ ...valid, ...patch })).toThrow(expected)
    }
  })

  it('rejects every malformed scalar in provider-loaded definitions', async () => {
    const cases: { patch: Partial<SkillDefinition>; expected: string }[] = [
      { patch: { name: { value: 'loaded' } as unknown as string }, expected: 'loaded skill name must be a string' },
      { patch: { name: 'Bad_Name' }, expected: 'loaded skill has invalid name' },
      { patch: { description: { value: 'description' } as unknown as string }, expected: 'description must be a string' },
      { patch: { description: '' }, expected: 'requires a description' },
      { patch: { disableModelInvocation: 'false' as unknown as boolean }, expected: 'disableModelInvocation must be a boolean' },
      { patch: { whenToUse: 1 as unknown as string }, expected: 'whenToUse must be a string' },
      { patch: { source: { value: 'source' } as unknown as string }, expected: 'source must be a string' },
      { patch: { provider: { value: 'provider' } as unknown as string }, expected: 'provider must be a string' },
      { patch: { content: { value: 'content' } as unknown as string }, expected: 'content must be a string' },
      { patch: { path: 1 as unknown as string }, expected: 'path must be a string' },
    ]
    for (const [index, { patch, expected }] of cases.entries()) {
      const ctx = new Context()
      await ctx.plugin(SkillService)
      const providerName = `definition-provider-${index}`
      const skillName = `definition-${index}`
      ctx.skills.registerProvider({
        name: providerName,
        list: () => Promise.resolve([{
          name: skillName,
          description: 'Candidate',
          provider: providerName,
          source: 'test',
          rank: 1,
          locator: 'definition',
        }]),
        get: () => Promise.resolve({
          name: skillName,
          description: 'Definition',
          whenToUse: 'Use this definition.',
          disableModelInvocation: false,
          provider: providerName,
          source: 'test',
          content: 'Definition body.',
          path: '/skills/definition/SKILL.md',
          ...patch,
        } as SkillDefinition),
      })

      await expect(ctx.skills.get(skillName)).rejects.toThrow(expected)
    }
  })

  it('validates provider candidates and invalid registry caps', async () => {
    const defaultedService = new SkillService(new Context())
    expect(await defaultedService.list()).toEqual([])

    const ctx = new Context()
    await ctx.plugin(SkillService)
    ctx.skills.registerProvider({
      name: 'bad',
      async list() {
        return [memorySkill('Bad_Name', 'bad', 1)]
      },
      async get() {
        return undefined
      },
    })
    await expect(ctx.skills.list()).rejects.toThrow('invalid skill name')

    const invalidCandidates = [
      { ...memorySkill('empty-description', '', 1), provider: 'empty-description' },
      { ...memorySkill('bad-rank', 'Bad rank', Number.NaN), provider: 'bad-rank' },
      { ...memorySkill('wrong-provider', 'Wrong provider', 1), provider: 'different' },
    ]
    for (const candidate of invalidCandidates) {
      const invalid = new Context()
      await invalid.plugin(SkillService)
      invalid.skills.registerProvider({
        name: candidate.name,
        async list() {
          return [candidate]
        },
        async get() {
          return undefined
        },
      })
      await expect(invalid.skills.list()).rejects.toThrow('skill provider')
    }

    await expect(new Context().plugin(SkillService, { collectCacheMaxEntries: 1.5 })).rejects.toThrow('collectCacheMaxEntries')
  })

  it('sorts model-visible summaries without locale-sensitive collation', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    ctx.skills.registerProvider(new MemoryProvider([
      memorySkill('z-skill', 'Z skill', 10),
      memorySkill('a-skill', 'A skill', 10),
    ]))
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
    const sort = vi.spyOn(Array.prototype, 'sort')

    try {
      const skills = await ctx.skills.list()
      expect(skills.map(skill => skill.name)).toEqual(['a-skill', 'z-skill'])
      expect(localeCompare).not.toHaveBeenCalled()

      const summaryComparator = sort.mock.calls.at(-1)?.[0]
      expect(summaryComparator).toBeTypeOf('function')
      expect(summaryComparator?.(skills[0], skills[0])).toBe(0)
    } finally {
      sort.mockRestore()
      localeCompare.mockRestore()
    }
  })

  it('caches provider discovery, skips failing providers, and invalidates on runtime skills', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService, { collectCacheMaxEntries: 1 })
    const provider = new MemoryProvider([memorySkill('first-skill', 'First', 10)])
    ctx.skills.registerProvider(provider)

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['first-skill'])
    provider.replace([memorySkill('second-skill', 'Second', 10)])
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['first-skill'])

    const disposeRuntime = ctx.skills.register({
      name: 'runtime-skill',
      description: 'Runtime',
      source: 'runtime',
      resourceBase: { kind: 'opaque', description: 'runtime memory' },
      path: 'memory://runtime-skill',
      metadata: { owner: 'tests' },
      content: 'Runtime body.',
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['runtime-skill', 'second-skill'])
    expect(await ctx.skills.get('runtime-skill')).toMatchObject({
      content: 'Runtime body.',
      path: 'memory://runtime-skill',
      metadata: { owner: 'tests' },
    })
    await disposeRuntime()
    await ctx.skills.list({ cwd: '/tmp/first-cache-key' })
    await ctx.skills.list({ cwd: '/tmp/second-cache-key' })

    let fail = true
    let flakyCalls = 0
    ctx.skills.registerProvider({
      name: 'flaky',
      async list() {
        flakyCalls += 1
        if (fail) throw new Error('transient discovery failure')
        return [{ ...memorySkill('flaky-skill', 'Flaky', 10), provider: 'flaky' }]
      },
      async get() {
        return undefined
      },
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['second-skill'])
    expect(flakyCalls).toBe(1)
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['second-skill'])
    expect(flakyCalls).toBe(2)
    fail = false
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['flaky-skill', 'second-skill'])
    expect(flakyCalls).toBe(3)
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['flaky-skill', 'second-skill'])
    expect(flakyCalls).toBe(3)
  })

  it('contains a provider rejection whose string coercion throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const hostileFailure = {
      toString() {
        throw new Error('provider failure coercion failed')
      },
    }
    ctx.skills.registerProvider({
      name: 'hostile-failure',
      list() {
        // Deliberately violate the provider contract to prove containment is total.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(hostileFailure)
      },
      async get() {
        return undefined
      },
    })

    await expect(ctx.skills.list()).resolves.toEqual([])
    expect(warnings).toEqual([
      'skill provider "hostile-failure" skipped: [unrenderable thrown value]',
    ])
  })

  it('abandons an in-flight catalog when provider registrations change', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    let markStarted: (() => void) | undefined
    let release: (() => void) | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const dispose = ctx.skills.registerProvider({
      name: 'delayed',
      async list() {
        markStarted?.()
        await gate
        return [{ ...memorySkill('stale-skill', 'Stale', 10), provider: 'delayed' }]
      },
      async get(candidate) {
        return { ...candidate, content: 'Stale body.' }
      },
    })

    const pending = ctx.skills.list()
    await started
    await dispose()
    release?.()

    expect(await pending).toEqual([])
  })

  it('stops waiting for discovery when its lookup signal aborts', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    let markStarted: (() => void) | undefined
    let release: (() => void) | undefined
    let seenSignal: AbortSignal | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const held = new Promise<SkillCandidate[]>((resolve) => {
      release = () => { resolve([]) }
    })
    ctx.skills.registerProvider({
      name: 'uncooperative',
      list(options) {
        seenSignal = options.signal
        markStarted?.()
        return held
      },
      async get() {
        return undefined
      },
    })
    const controller = new AbortController()
    const reason = 'discovery cancelled'
    const pending = ctx.skills.list({ signal: controller.signal })
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => error instanceof Error && error.message === reason ? 'aborted' : 'other-error',
    )
    await started
    controller.abort(reason)

    const settled = await Promise.race([
      outcome,
      new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 25)),
    ])
    release?.()
    await pending.catch(() => undefined)

    expect(seenSignal).toBe(controller.signal)
    expect(settled).toBe('aborted')
  })

  it('does not miss an abort racing listener installation', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    const reason = new Error('racing abort')
    let aborted = false
    const signal = {
      get aborted() {
        return aborted
      },
      reason,
      throwIfAborted() {
        if (aborted) throw reason
      },
      addEventListener(_type: string, listener: () => void) {
        aborted = true
        listener()
      },
      removeEventListener() {},
    } as unknown as AbortSignal
    ctx.skills.registerProvider({
      name: 'racing-abort',
      list() {
        return Promise.reject(new Error('late provider failure'))
      },
      async get() {
        return undefined
      },
    })

    await expect(ctx.skills.list({ signal })).rejects.toBe(reason)
    await Promise.resolve()
  })

  it('rejects invalid runtime skill registrations and ignores duplicates', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillService)
    expect(() => ctx.skills.register({ name: 'Bad_Name', description: 'Bad', source: 'runtime', content: 'bad' })).toThrow('invalid skill name')
    expect(() => ctx.skills.register({ name: 'no-description', description: '', source: 'runtime', content: 'bad' })).toThrow('requires a description')
    expect(await ctx.skills.get('missing-skill')).toBeUndefined()
    expect(await ctx.skills.get('Bad_Name')).toBeUndefined()

    const disposeFirst = ctx.skills.register({ name: 'same-skill', description: 'First', source: 'runtime', content: 'first' })
    const disposeSecond = ctx.skills.register({ name: 'same-skill', description: 'Second', source: 'runtime', content: 'second' })
    await disposeSecond()
    expect((await ctx.skills.get('same-skill'))?.description).toBe('First')
    await disposeFirst()
    expect(await ctx.skills.get('same-skill')).toBeUndefined()
  })
})
