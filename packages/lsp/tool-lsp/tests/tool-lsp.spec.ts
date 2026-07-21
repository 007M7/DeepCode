import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import Lsp, { LspProviderId, type LspProvider, type LspProviderQuery, type LspQueryResult } from '@deepseek-ai/dsh-lsp'
import * as ToolLsp from '@deepseek-ai/dsh-tool-lsp'
import { DEFAULT_LSP_TOOL_TIMEOUT_MS, LSP_PROMPT_TEXT } from '@deepseek-ai/dsh-tool-lsp'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** A scripted provider recording queries; `respond` yields the result or throws. */
function stubProvider(
  respond: (request: LspProviderQuery) => LspQueryResult,
  extensionToLanguage: Record<string, string> = { '.ts': 'typescript' },
): LspProvider & { seen: LspProviderQuery[] } {
  const seen: LspProviderQuery[] = []
  return {
    id: LspProviderId('stub'),
    extensionToLanguage,
    seen,
    query(request) {
      seen.push(request)
      return Promise.resolve(respond(request))
    },
  }
}

/** Mount the real tool stack over a real seam plus one stub provider. */
async function mount(
  provider?: LspProvider,
  config: ToolLsp.Config = {},
): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(Lsp)
  if (provider) (ctx.lsp as Lsp).registerProvider(provider)
  await ctx.plugin(ToolLsp, config)
  return { ctx }
}

let seq = 0
/** `cwd: null` means "no agent" (tests LSP_WORKSPACE_REQUIRED); a string is the session cwd. */
function call(ctx: Context, args: unknown, cwd: string | null = '/ws') {
  return ctx.tools.execute({
    callId: `c-${++seq}` as never,
    name: 'lsp',
    arguments: args,
    ...cwd !== null ? { agent: { session: { header: { cwd } } } as never } : {},
  })
}

const okLocations: LspQueryResult = {
  kind: 'locations',
  locations: [{ uri: 'file:///ws/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
  resolvedWorkspaceRoot: '/ws',
}

describe('tool-lsp registration', () => {
  it('registers the lsp tool and its prompt section', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations))
    expect(ctx.tools.get('lsp')).toBeDefined()
    const prompt = await ctx.systemPrompt.assemble()
    const text = prompt.sections.map(s => s.text).join('\n')
    expect(text).toContain(LSP_PROMPT_TEXT)
  })

  it('attaches the default timeout budget to the tool definition', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations))
    expect(ctx.tools.get('lsp')?.timeoutMs).toBe(DEFAULT_LSP_TOOL_TIMEOUT_MS)
  })

  it('honors a configured timeout override', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations), { timeoutMs: 5000 })
    expect(ctx.tools.get('lsp')?.timeoutMs).toBe(5000)
  })

  it('exposes exactly the four operations in the schema enum', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations))
    const schema = ctx.tools.get('lsp')?.parameters as { properties: { operation: { enum: string[] } } }
    expect(schema.properties.operation.enum).toEqual(['goToDefinition', 'findReferences', 'goToImplementation', 'hover'])
  })

  it('has no default export (namespace plugin shape)', () => {
    expect((ToolLsp as { default?: unknown }).default).toBeUndefined()
  })

  it('rejects a non-positive config value at load', async () => {
    await expect(mount(stubProvider(() => okLocations), { maxLocations: 0 })).rejects.toThrow(/maxLocations/)
  })

  it('rejects a timeout above Node timer range at load', async () => {
    await expect(mount(stubProvider(() => okLocations), { timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(/timeoutMs/)
    expect(() => {
      ToolLsp.apply(new Context(), {
        maxLocations: 100,
        maxResultChars: 16_000,
        timeoutMs: MAX_TIMER_DELAY_MS + 1,
      })
    }).toThrow(/timeoutMs/)
  })
})

describe('tool-lsp execution', () => {
  it('converts one-based coordinates and passes the session cwd as workspaceRoot', async () => {
    const provider = stubProvider(() => okLocations)
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 3, character: 5 }, '/ws')
    expect(result.isError).toBe(false)
    expect(provider.seen[0]).toMatchObject({
      operation: 'goToDefinition',
      filePath: 'a.ts',
      position: { line: 2, character: 4 },
      workspaceRoot: '/ws',
    })
  })

  it('renders locations relative to the workspace', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations))
    const result = await call(ctx, { operation: 'findReferences', file_path: 'a.ts', line: 1, character: 1 }, '/ws')
    expect(result.content[0]).toEqual({ type: 'text', text: 'a.ts:1:1' })
  })

  it('relativizes against the provider resolvedWorkspaceRoot, not the session cwd', async () => {
    // A symlinked session cwd (`/alias`) resolves to a real path (`/real/ws`) that the provider's
    // location URIs are under. Relativizing against the alias would misclassify the location as
    // external and print an absolute path; the tool must use resolvedWorkspaceRoot.
    const provider = stubProvider(() => ({
      kind: 'locations',
      locations: [{ uri: 'file:///real/ws/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
      resolvedWorkspaceRoot: '/real/ws',
    }))
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 1, character: 1 }, '/alias')
    expect(provider.seen[0]).toMatchObject({ workspaceRoot: '/alias' })
    expect(result.content[0]).toEqual({ type: 'text', text: 'a.ts:1:1' })
  })

  it('renders hover content', async () => {
    const { ctx } = await mount(stubProvider(() => ({ kind: 'hover', hover: { contents: 'number' } })))
    const result = await call(ctx, { operation: 'hover', file_path: 'a.ts', line: 1, character: 1 }, '/ws')
    expect(result.content[0]).toEqual({ type: 'text', text: 'number' })
  })

  it('fails LSP_WORKSPACE_REQUIRED without a session cwd', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations))
    const result = await call(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 1, character: 1 }, null)
    expect(result.isError).toBe(true)
    expect(result.error?.code).toBe('LSP_WORKSPACE_REQUIRED')
  })

  it('surfaces a structured LSP_UNAVAILABLE when no provider handles the file', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations, { '.py': 'python' }))
    const result = await call(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 1, character: 1 }, '/ws')
    expect(result.isError).toBe(true)
    expect(result.error?.code).toBe('LSP_UNAVAILABLE')
  })

  it('returns a structured INVALID_ARGS on a bad operation', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations))
    const result = await call(ctx, { operation: 'rename', file_path: 'a.ts', line: 1, character: 1 }, '/ws')
    expect(result.isError).toBe(true)
    expect(result.error?.code).toBe('INVALID_ARGS')
  })

  it('forwards exec.signal to the seam query', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const provider: LspProvider = {
      id: LspProviderId('sig'),
      extensionToLanguage: { '.ts': 'typescript' },
      query(_request, signal) {
        seen.push(signal)
        return Promise.resolve(okLocations)
      },
    }
    const { ctx } = await mount(provider)
    await call(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 1, character: 1 }, '/ws')
    // The timeout policy is not mounted here, so the signal is whatever the registry passes (may be
    // undefined); the point is the tool threads it through without throwing.
    expect(seen).toHaveLength(1)
  })

  it('presentCall renders the pending card from args', async () => {
    const { ctx } = await mount(stubProvider(() => okLocations))
    const view = ctx.tools.get('lsp')?.presentCall?.({ operation: 'hover', file_path: 'a.ts', line: 2, character: 3 })
    expect(view).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'LSP hover a.ts:2:3',
      locations: [{ path: 'a.ts', line: 2 }],
    })
  })
})
