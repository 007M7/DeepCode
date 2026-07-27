# Agent Note: Replace tool-web's regex HTML-to-markdown converter with turndown

Status: implemented

English | [中文](2026-07-26-turndown-for-tool-web-html-markdown.zh.md)

## Problem

`dsh-tool-web`'s `src/html.ts` (~86 lines, ~40 lines of dedicated tests; deleted by this change) converted fetched HTML to markdown with regexes: strip script/style/noscript/comments, convert `<a>`/`<h1-6>`/`<li>`, decode numeric entities plus a 12-entry named-entity table, collapse whitespace. The module's own JSDoc said "A richer converter can replace it without changing the seam or tool schema", and the README's Known Limitations documented it as "a minimal regex converter, not an HTML parser — tables, images, and nested formatting are lost." The [web capability seam note](../architecture/2026-06-24-web-capability-seam.md) assigns HTML→markdown to this package as presentation, so the swap point was exactly here. The converter's output is model-visible on every fetched HTML page; no keyless snapshot exercised `web_fetch`, so no expected outputs pinned it.

## Decision

`packages/web/tool-web/src/fetch.ts` owns a module-level [`turndown`](https://github.com/mixmark-io/turndown) instance (`headingStyle: 'atx'`, `codeBlockStyle: 'fenced'`, `bulletListMarker: '-'` — fixed model-facing presentation, not deployment tunables) with `@joplin/turndown-plugin-gfm`'s composite `gfm` plugin for tables/strikethrough and `remove(['script', 'style', 'noscript'])` replacing the old wholesale drops. `renderBody`'s `html` arm guards the conversion twice: a linear tag-scan preflight passes bodies nested past 512 levels through raw (the synchronous walk is superlinear on unclosed nesting — measured seconds at 20k levels — during which the cooperative timeout cannot fire), and a try/catch falls back to the raw HTML when turndown still throws on markup the scan cannot see; a degraded page beats an error for a body the provider already decoded. `formatFetchOutput` bounds the complete output (`fetchMaxOutputChars` config, default 200,000) because markdown escaping can expand converted HTML to ~2× a provider's body cap. `html.ts` and its conversion tests are deleted; the fallback and the status-header/truncation-footer formatting are tested in `tests/tool-web.spec.ts`, and the README's Known Limitations trades the regex-converter caveat for the pathological-nesting fallback. The gfm plugin ships no types; `src/turndown-plugin-gfm.d.ts` declares the one imported export over `@types/turndown` (a devDependency).

The dependency-weight question the proposal flagged resolves in favor of the swap: `@deepseek-ai/dsh-tool-web` is in the single-file-executable closure ([single-exe note](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)), and the exe's asset globs would pack ~7.9 MB of the three packages as published — but ~6 MB of that is `@mixmark-io/domino`'s test corpus (`test/**`), with runtime `lib/` at ~550 KB against a ~174 MB artifact, under 0.5% either way.

## Snapshot coverage

The previously-missing keyless `web_fetch` snapshot ships with the change as the acp-agent scenario `web-fetch`: `examples/acp-agent/web.cordis.yml` composes the web seam, the real `dsh-web-fetch-local` provider, `tool-web` with `search: false`, and `web-fetch-fixture-server.mjs` — a loopback HTTP fixture on a fixed port (the fetched URL is part of the recorded transcript) serving deterministic HTML with named entities, a GFM table, and nested formatting. Recording and keyless replay both drive the real HTTP fetch and conversion; the pinned tool result is the turndown output, and the scenario pins the `web` header class (the `web_fetch` schema and guidance).

## Alternatives considered

- **`@mozilla/readability` + a DOM.** Solves a different problem (content extraction, not conversion) and drags a heavier DOM dependency; the seam only asks for markdown rendering of whatever the fetch returned.
- **Keep the regex converter.** It was an explicit v1 placeholder per its own JSDoc; keeping it meant model-visible quality (tables, images, nested formatting) stayed lost for the cost of maintaining bespoke entity tables.
- **The minimal `entities`-only variant.** The proposal's fallback position: replace only the entity-decoding third of `html.ts` with the zero-dependency `entities` package, deleting less but avoiding the dependency-weight question. Not taken because the closure math above made the weight immaterial while the full swap deletes the whole hand-rolled converter and its documented quality gaps.
- **`turndown-plugin-gfm` (the original) instead of `@joplin/turndown-plugin-gfm`.** The original is unmaintained (last publish 2018); the Joplin fork is current against turndown 7 and actively released.

## Consequences

- **Bought**: full-fidelity model-visible markdown — tables, images, strikethrough, nested emphasis, fenced code blocks, and the complete named-entity set — plus the deletion of the bespoke converter and its entity tables, with the README's regex-converter caveat narrowed to one degenerate case.
- **Paid**: two runtime dependencies (`turndown` → `@mixmark-io/domino`) enter tool-web and therefore the exe closure (~550 KB of runtime code as measured above), and a new failure mode — pathological nesting — is handled by falling back to raw HTML rather than converting.
- Model-visible output changed on every fetched HTML page; nothing pinned the old output, and the new snapshot pins the new one.

## Testing

- `packages/web/tool-web/tests/tool-web.spec.ts` covers the turndown conversion surface (entities, links, tables, nesting, script/style/noscript removal) through `renderBody`, the fast raw-HTML passthrough for 20k-level nesting, the depth scan's void/self-closing/unbalanced cases, the residual converter-throw fallback, and the whole-output cap at expanding, exact, and tiny budgets; per-file coverage on the package src is 100%.
- The `web-fetch` acp-agent snapshot pins the assembled behavior keylessly end to end (real Loader composition, real HTTP fetch, real conversion).
