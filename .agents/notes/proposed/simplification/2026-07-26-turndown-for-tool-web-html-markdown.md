# Agent Note: Replace tool-web's regex HTML-to-markdown converter with turndown

Status: proposed

English | [中文](2026-07-26-turndown-for-tool-web-html-markdown.zh.md)

## Problem

`packages/web/tool-web/src/html.ts` (~86 lines, ~40 lines of dedicated tests) converts fetched HTML to markdown with regexes: strip script/style/noscript/comments, convert `<a>`/`<h1-6>`/`<li>`, decode numeric entities plus a 12-entry named-entity table, collapse whitespace. The module's own JSDoc says "A richer converter can replace it without changing the seam or tool schema", and the README's Known Limitations documents it as "a minimal regex converter, not an HTML parser — tables, images, and nested formatting are lost." The [web capability seam note](../../implemented/architecture/2026-06-24-web-capability-seam.md) assigns HTML→markdown to this package as presentation, so the swap point is exactly here. The converter's output is model-visible on every fetched HTML page; no keyless snapshot currently exercises `web_fetch`, so no expected outputs pin it.

## Proposal

Replace `htmlToMarkdown` with `turndown` (`new TurndownService().turndown(html)`), optionally with `turndown-plugin-gfm` for tables. The consumer switch in `fetch.ts` and the status-header/truncation-footer formatting stay. Wrap the call in try/catch falling back to the raw text path: the regex version could never throw; turndown on pathological HTML could. Delete `html.ts` and its conversion tests; keep tests for the fallback and the surrounding formatting. Update the README's Known Limitations to drop the regex-converter caveat.

If the "deliberately minimal fallback" stance is preferred instead, a minimal variant still deletes the worst part: replace the entity-decoding third of the file (~30 lines: `decodeEntities`, `NAMED_ENTITIES`, `safeFromCodePoint`) with the zero-dependency `entities` package (already in the lockfile transitively), erasing the documented "about a dozen entities" limitation at near-zero risk.

## Alternatives considered

- **`@mozilla/readability` + a DOM.** Solves a different problem (content extraction, not conversion) and drags a heavier DOM dependency; the seam only asks for markdown rendering of whatever the fetch returned.
- **Keep the regex converter.** It was an explicit v1 placeholder per its own JSDoc; keeping it means model-visible quality (tables, images, nested formatting) stays lost for the cost of maintaining bespoke entity tables.
- **The minimal `entities`-only variant.** Kept in the proposal as the fallback position; it deletes less but avoids the dependency-weight question entirely.

## Acceptance criteria

- `web_fetch` renders tables/nested formatting via turndown (or, minimal variant: decodes all named entities), with the README limitation updated.
- Unit tests cover the fallback path; `pnpm run test` passes for the package.
- A keyless snapshot exercising `web_fetch` markdown rendering is added per testing policy (the missing snapshot coverage is part of the change, and it pins the new output).

## Risks

- Model-visible output changes on every fetched HTML page — transcript drift is acceptable pre-release, and nothing currently pins the old output.
- Dependency weight: turndown's one dependency (`@mixmark-io/domino`) is a ~200 KB DOM that would enter the single-file-executable closure if tool-web ships in it ([single-exe note](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)); the minimal `entities` variant avoids this if closure size is the deciding factor.
