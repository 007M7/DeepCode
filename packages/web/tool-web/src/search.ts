/**
 * The model-facing `web_search` tool: discover current information on the web.
 * Execution goes through `ctx.web` — this module owns only the model-facing
 * schema, argument validation, the result-count bound, and result formatting,
 * never provider selection or network access.
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * Default upper bound on returned sources. Owned by the consumer (not the
 * provider or model), mirroring `dsh-tool-fs`'s `READ_LIMIT`/`GREP_LIMIT`. The
 * model just asks a question; the product controls how much context returns.
 * The default `8` aligns with OpenCode's Exa default.
 */
export const WEB_SEARCH_MAX_RESULTS = 8

/** Validate value constraints the schema DSL can't express. */
export function parseSearchArgs(args: { query: string }): { query: string } {
  if (args.query.trim().length === 0) throw new Error('query must be a non-empty string')
  return { query: args.query }
}

/** Display label for a source: its title, else its hostname. */
function sourceLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title.length > 0) return title
  try {
    return new URL(url).hostname
  } catch {
    // A provider should return a valid URL, but never let a malformed one throw
    // out of pure formatting — fall back to the raw string.
    return url
  }
}

/** Format a search result as one model-facing text block. */
export function formatSearchOutput(result: WebSearchResult): string {
  const parts: string[] = []
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content)

  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title)
      const meta: string[] = []
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push('No results found.')
  }

  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/** Pending-call presentation: a search card titled by the query. */
export function presentSearchCall(args: { query: string }): GenericCallView {
  return { card: 'generic', title: args.query, kind: 'search', rawInput: args.query }
}

/** Register the `web_search` tool and its system-prompt guidance. */
export function applyWebSearchTool(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:web_search',
    order: 110,
    text: 'Use the web_search tool to discover current information on the web. It returns an optional answer plus a list of source URLs. Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links.',
  })

  ctx.tools.register(defineTool({
    name: 'web_search',
    description: 'Search the web for current information. Returns an optional summary answer and a list of source URLs.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
    },
    async execute(args, exec): Promise<ContentBlock[]> {
      const input = parseSearchArgs(args)
      const result = await ctx.web.search(
        { query: input.query, maxResults: WEB_SEARCH_MAX_RESULTS },
        exec.signal ? { signal: exec.signal } : undefined,
      )
      return [{ type: 'text', text: formatSearchOutput(result) }]
    },
    presentCall: presentSearchCall,
  }))
}
