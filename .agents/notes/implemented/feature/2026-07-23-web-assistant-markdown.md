# Agent Note: Safe assistant Markdown in the Web conversation

Status: implemented

English | [中文](2026-07-23-web-assistant-markdown.zh.md)

## Problem

The Web conversation preserves assistant Markdown source through session events, history replay, and streaming accumulation, but its terminal text primitive renders that source literally. Changing the shared primitive would also format user and steering messages, while parsing in the runtime would mix presentation state into the React-free session projection.

## Decision

`@deepseek-ai/dsh-client-ui-primitives` exports `MarkdownText` as the untrusted assistant-text renderer, and `ui-conversation` selects it only for assistant `text` blocks. Finalized history, the streaming tail, and interrupted partials already share `AssistantMarkdown`, so they receive the same renderer without changing events or snapshots. User and steering messages keep `MessageText` and remain literal.

`MarkdownText` uses `react-markdown` with `remark-gfm` to build React elements from an AST. It covers CommonMark blocks plus GFM tables, task lists, strikethrough, and autolinks without raw-HTML parsing. Fenced code routes through the shared `CodeBlock`, which highlights registered grammars with the client's shiki singleton (`--shiki-*` tokens) and falls back to plain monospace otherwise. While a turn streams, fences stay on the plain arm so growing fences are not retokenized every chunk.

Visual spacing, tables, links, blockquotes, inline code, and code-block chrome follow deepsuite `@deepseek/md` (`markdown.css` / `code-block.css`) and the same `--dsw-alias-markdown-*`, `--dsw-font-markdown-*`, `--dsw-alias-border-l*`, and `--dsw-alias-label-*` tokens. Links use `--dsw-alias-state-business-primary` (deepsuite's sheet uses `--dsw-alias-brand-text`, which is blue only under newDesign; design-platform keeps brand-text near-black and is not retuned here). `CodeBlock` ships a language banner and a copy control (`复制` / `复制成功`). Finalized text renders KaTeX through `remark-math` and `rehype-katex`; `remarkMathCompatibility` maps `\(...\)`, `\[...\]`, and block-level same-line `$$...$$` to the same standard math AST nodes. This is a narrow parser compatibility layer, not a regex rewrite or malformed-model-output repair. Streaming stays literal until finalization so incomplete formulae do not flash errors. Citation pills, heading anchors, the thinking-small markdown variant, and custom □/☑ task markers remain out of scope; GFM task lists keep native checkboxes.

The dependency is explicit in `ui-primitives`; because that pure library is seeded by the Web shell, the parser and highlighter are part of the initial browser bundle.

## Untrusted output policy

Assistant-authored link destinations are restricted to absolute HTTP, HTTPS, and mailto URLs. HTTP(S) links open in a new tab with `rel="noopener noreferrer"`; relative destinations and other protocols render as non-navigable text. Markdown images follow the separate [remote-image policy](2026-07-30-web-remote-markdown-images.md). Raw HTML remains inert source text because no HTML parser enters the pipeline. Shiki output is a static span tree generated from the fence text (no scripts or user HTML).

Fenced code and GFM tables own horizontal overflow so long content cannot widen the conversation column.

## Alternatives considered

**Promote the existing mdast and micromark development dependencies and maintain a custom React walker.** This avoids a new parser family but makes the product own every node mapping, GFM extension, and security-sensitive rendering branch. The dedicated React renderer keeps that traversal upstream while preserving an AST-to-React path.

**Replace `MessageText` with Markdown rendering.** This formats user prompts and steering as a side effect. Those authored surfaces remain literal until the product chooses that behavior explicitly.

**Parse Markdown into session snapshots.** This would make React nodes or presentation ASTs durable runtime state and reintroduce a final-versus-streaming mode boundary. Parsing stays at the presentation leaf instead.

**Enable raw HTML with sanitization.** Raw HTML has no current product need and would enlarge the executable-content boundary, so it remains disabled rather than adding a sanitizer dependency. Remote images are governed by the later [image policy](2026-07-30-web-remote-markdown-images.md).

**Port deepsuite Prism `highlight.css` and the mdast pipeline.** Appearance parity is owned by CSS Modules and shared `--dsw-*` tokens; highlighting stays on the existing shiki allowlist so the client does not take a second highlighter or Prism class contract.

## Consequences

Assistant replies render semantic Markdown consistently during streaming and replay, while tool cards, reasoning rows, interactions, user bubbles, and the host protocol remain unchanged. Streaming reparses the current text after each accumulated update; incomplete Markdown can temporarily change structure, but the isolated tail bounds React invalidation and the final event does not switch renderers. Code fences share one chrome and copy path with tool and details surfaces. The initial Web shell includes the Markdown parser, GFM runtime, KaTeX, and shiki allowlist; citation, anchor, and thinking-small surfaces remain deferred.
