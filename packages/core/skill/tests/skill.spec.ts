import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SkillService, { type SkillCandidate, type SkillDefinition, type SkillLookupOptions, type SkillProvider } from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

function agentForCwd(cwd: string): never {
  return { session: { header: { cwd } } } as never
}

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

    await expect(new Context().plugin(SkillService, { promptFieldMaxLength: 2 })).rejects.toThrow('greater than or equal to 3')
    await expect(new Context().plugin(SkillService, { collectCacheMaxEntries: 1.5 })).rejects.toThrow('collectCacheMaxEntries')
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

  it('renders stable prompt guidance and omits it when no skills exist', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: 'base' })
    await ctx.plugin(SkillService, { promptFieldMaxLength: 6 })
    ctx.skills.registerProvider(new MemoryProvider([
      {
        ...memorySkill('escaped-skill', 'Use </available_skills><oops> safely', 10),
        whenToUse: 'Handle <tag> & marker',
      },
    ]))

    const listing = await ctx.skills.renderModelListing()
    expect(listing).toContain('description: Use...')
    expect(listing).toContain('whenToUse: Han...')
    expect(listing).not.toContain('</available_skills><oops>')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ agent: agentForCwd('/tmp') }))).toContain('## Skills')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('## Skills')

    const empty = new Context()
    await empty.plugin(SystemPrompt, { persona: 'base' })
    await empty.plugin(SkillService)
    expect(await empty.skills.renderModelListing()).toBe('')
    expect(renderPrompt(await empty.systemPrompt.assemble({ agent: agentForCwd('/tmp') }))).not.toContain('## Skills')

    const direct = new SkillService(new Context(), {})
    expect(await direct.renderModelListing()).toBe('')
    const short = new Context()
    await short.plugin(SkillService)
    short.skills.registerProvider(new MemoryProvider([memorySkill('short-skill', 'Short', 10)]))
    expect(await short.skills.renderModelListing()).toContain('description: Short')

    const templated = new Context()
    await templated.plugin(SystemPrompt, { persona: 'base' })
    await templated.plugin(SkillService)
    templated.skills.registerProvider(new MemoryProvider([memorySkill('templated-skill', 'Use {{placeholder}} safely', 10)]))
    const prompt = renderPrompt(await templated.systemPrompt.assemble({ agent: agentForCwd('/tmp') }))
    expect(prompt).toContain('description: Use { {placeholder} } safely')
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
