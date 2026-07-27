/**
 * The model-facing `web_fetch` tool. This module owns its schema, validation, and presentation;
 * `ctx.web` owns retrieval. Timeout is deployment policy, not a model argument: config becomes
 * `ToolDefinition.timeoutMs`, timeout policy enforces it, and this tool forwards the resulting
 * signal. A provider timeout remains a backstop for direct seam callers.
 */

import type { Context } from 'cordis'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { WebFetchBody, WebFetchResult } from '@deepseek-ai/dsh-web'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * The shared HTML→markdown converter: turndown over its bundled domino DOM,
 * with GitHub-flavored tables/strikethrough (`@joplin/turndown-plugin-gfm`).
 * The style options are fixed model-facing presentation (matching the repo's
 * markdown conventions), not deployment tunables. `remove` drops non-content
 * elements wholesale — turndown's default keeps their text. The instance is
 * stateless across `turndown()` calls and safe to share.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)
turndown.remove(['script', 'style', 'noscript'])

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
 * Nesting-depth ceiling above which HTML skips conversion and passes through
 * raw. Conversion runs synchronously on the event loop, and unclosed-tag
 * nesting makes domino's tree (and turndown's walk over it) superlinear —
 * measured: depth 512 ≈ 0.15s, 2,000 ≈ 2s, 20,000 ≈ 5s — during which the
 * cooperative `fetchTimeoutMs` timer cannot fire. Real pages nest a few dozen
 * levels; 512 is far above content and far below weaponizable. A robustness
 * invariant, not a tunable.
 */
const MAX_CONVERSION_DEPTH = 512

/** Elements that never take a closing tag, so they must not count toward nesting depth. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Estimate the maximum element nesting depth of an HTML string with one linear
 * tag scan. Overestimates when markup-like text sits inside `script`/`style`
 * bodies or comments (the scan does not parse those), which can only cause a
 * spurious raw-HTML fallback, never a missed bound.
 *
 * @param html - the decoded HTML body.
 * @returns the deepest open-element count the scan reaches.
 */
export function htmlNestingDepth(html: string): number {
  let depth = 0
  let max = 0
  for (const tag of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*?(\/?)>/g)) {
    const [, closing, rawName = '', selfClosing] = tag
    const name = rawName.toLowerCase()
    if (VOID_ELEMENTS.has(name) || selfClosing === '/') continue
    if (closing === '/') {
      if (depth > 0) depth -= 1
    } else {
      depth += 1
      if (depth > max) max = depth
    }
  }
  return max
}

/**
 * Render a fetched body to model-facing markdown text.
 *
 * @param body - the decoded body; `html` is converted via turndown, `text`
 *   passes through verbatim. HTML nested beyond {@link MAX_CONVERSION_DEPTH}
 *   skips conversion up front (the synchronous walk over such trees is
 *   superlinear and blocks the event loop past the cooperative timeout), and
 *   when turndown itself throws the raw HTML passes through instead — a
 *   degraded page beats an error for a body the provider already decoded.
 * @returns the text for the tool's output block.
 */
export function renderBody(body: WebFetchBody): string {
  switch (body.kind) {
    case 'html':
      if (htmlNestingDepth(body.content) > MAX_CONVERSION_DEPTH) return body.content
      try {
        return turndown.turndown(body.content)
      } catch {
        // turndown's DOM walk recurses per element; malformed markup the depth
        // scan cannot see can still throw RangeError. Provider errors stay
        // structured WebErrors upstream; conversion failure downgrades to raw HTML.
        return body.content
      }
    case 'text':
      return body.content
    /* v8 ignore next 2 -- WebFetchBody is a closed union; this arm is unreachable and only makes adding a kind a compile error. */
    default:
      return assertNever(body, 'unhandled web fetch body kind')
  }
}

/** The truncation notice appended when the provider or the output cap cut content. */
const TRUNCATION_FOOTER = '\n\n(Content truncated. Fetch a more specific URL or section for the full text.)'

/**
 * Format a fetch result as one model-facing text block, bounded as a whole.
 * Markdown escaping can expand converted HTML (worst case ~2× the provider's
 * body cap), so the bound applies here, where the complete output — header,
 * rendered body, and footer — is known.
 *
 * @param result - the seam's fetch outcome.
 * @param maxOutputChars - cap on the complete returned string; a cut body gets
 *   the same fetch-something-narrower notice as provider-side truncation.
 * @returns a `Fetched <url> (HTTP <status>)` header, the rendered body, and a
 *   truncation notice when the provider or the cap cut the content.
 */
export function formatFetchOutput(result: WebFetchResult, maxOutputChars: number): string {
  const header = `Fetched ${result.url} (HTTP ${result.statusCode})\n\n`
  const body = renderBody(result.body)
  const full = `${header}${body}${result.truncated ? TRUNCATION_FOOTER : ''}`
  if (full.length <= maxOutputChars) return full
  const budget = Math.max(0, maxOutputChars - header.length - TRUNCATION_FOOTER.length)
  return `${header}${body.slice(0, budget)}${TRUNCATION_FOOTER}`
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
 * @param maxOutputChars - cap on the complete rendered tool output (see
 *   {@link formatFetchOutput}); markdown escaping can outgrow the provider's
 *   body cap, so the model-context bound is enforced on the rendered result.
 */
export function applyWebFetchTool(ctx: Context, timeoutMs: number, maxOutputChars: number): void {
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
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          statusCode: { type: 'integer', required: true },
          body: {
            required: true,
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'html' },
                  content: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'text' },
                  content: { type: 'string', required: true },
                },
              },
            ],
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatFetchOutput(value, maxOutputChars) }],
    },
    timeoutMs,
    // Provider reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseFetchArgs(args)
      const result = await ctx.web.fetch(
        { url: input.url },
        exec.signal,
      )
      return {
        url: result.url,
        statusCode: result.statusCode,
        body: { kind: result.body.kind, content: result.body.content },
        truncated: result.truncated,
      }
    },
    presentCall: presentFetchCall,
  }))
}
