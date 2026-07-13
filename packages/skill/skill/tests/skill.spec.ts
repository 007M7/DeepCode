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

    disposeMemory()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['same-rank-skill', 'shadowed'])
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
    disposeRuntime()
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
    dispose()
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
    disposeSecond()
    expect((await ctx.skills.get('same-skill'))?.description).toBe('First')
    disposeFirst()
    expect(await ctx.skills.get('same-skill')).toBeUndefined()
  })
})
