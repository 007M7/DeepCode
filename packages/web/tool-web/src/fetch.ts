/**
 * The model-facing `web_fetch` tool. This module owns its schema, validation, and presentation;
 * `ctx.web` owns retrieval. Timeout is deployment policy, not a model argument: config becomes
 * `ToolDefinition.timeoutMs`, timeout policy enforces it, and this tool forwards the resulting
 * signal. A provider timeout remains a backstop for direct seam callers.
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { WebFetchBody, WebFetchResult } from '@deepseek-ai/dsh-web'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { htmlToMarkdown } from './html.ts'

/**
 * Validate value constraints the schema DSL can't express: a non-blank `url`.
 * Throws a plain `Error` otherwise. No timeout parameter — the tool-call budget
 * is deployment policy declared via `fetchTimeoutMs` config and enforced by
 * `@deepseek-ai/dsh-timeout-policy`, not a model argument.
 *
 * @param args - the schema-validated `web_fetch` arguments.
 * @returns the arguments as the seam's request fields.
 */
export function parseFetchArgs(args: { url: string }): { url: string } {
  if (args.url.trim().length === 0) throw new Error('url must be a non-empty string')
  return { url: args.url }
}

/**
 * Render a fetched body to model-facing markdown text.
 *
 * @param body - the decoded body; `html` is converted via
 *   {@link htmlToMarkdown}, `text` passes through verbatim.
 * @returns the text for the tool's output block.
 */
export function renderBody(body: WebFetchBody): string {
  switch (body.kind) {
    case 'html':
      return htmlToMarkdown(body.content)
    case 'text':
      return body.content
    /* v8 ignore next 2 -- WebFetchBody is a closed union; this arm is unreachable and only makes adding a kind a compile error. */
    default:
      return assertNever(body, 'unhandled web fetch body kind')
  }
}

/**
 * Format a fetch result as one model-facing text block.
 *
 * @param result - the seam's fetch outcome.
 * @returns a `Fetched <url> (HTTP <status>)` header, the rendered body, and a
 *   fetch-something-narrower notice when the provider truncated the content.
 */
export function formatFetchOutput(result: WebFetchResult): string {
  const header = `Fetched ${result.url} (HTTP ${result.statusCode})`
  const footer = result.truncated ? '\n\n(Content truncated. Fetch a more specific URL or section for the full text.)' : ''
  return `${header}\n\n${renderBody(result.body)}${footer}`
}

/**
 * Pending-call presentation: a fetch card titled by the URL.
 *
 * @param args - the raw tool arguments; only `url` feeds the view.
 * @returns the generic card view (`kind: 'fetch'`) shown while the call runs.
 */
export function presentFetchCall(args: { url: string }): GenericCallView {
  return { card: 'generic', title: args.url, kind: 'fetch', rawInput: args.url }
}

/**
 * Register the `web_fetch` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param timeoutMs - the cooperative tool-call budget (ms) attached as the tool's
 *   `ToolDefinition.timeoutMs` for `@deepseek-ai/dsh-timeout-policy` to enforce.
 */
export function applyWebFetchTool(ctx: Context, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:web_fetch',
    order: 111,
    text: 'Use the web_fetch tool to retrieve the content of a specific HTTP(S) URL (for example a result from web_search). It returns the page content decoded to text. Cite the URL as a markdown link when you use its content.',
  })

  ctx.tools.register(defineTool({
    name: 'web_fetch',
    description: 'Fetch the content of a specific HTTP(S) URL and return it decoded to text.',
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to fetch.' },
    },
    timeoutMs,
    async execute(args, exec): Promise<ContentBlock[]> {
      const input = parseFetchArgs(args)
      const result = await ctx.web.fetch(
        { url: input.url },
        exec.signal,
      )
      return [{ type: 'text', text: formatFetchOutput(result) }]
    },
    presentCall: presentFetchCall,
  }))
}
