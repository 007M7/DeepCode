# Agent Note: Safe assistant Markdown in the Web conversation

Status: implemented

English | [中文](2026-07-23-web-assistant-markdown.zh.md)

## Problem

The Web conversation preserves assistant Markdown source through session events, history replay, and streaming accumulation, but its terminal text primitive renders that source literally. Changing the shared primitive would also format user and steering messages, while parsing in the runtime would mix presentation state into the React-free session projection.

## Decision

`@deepseek-ai/dsh-client-ui-primitives` exports `MarkdownText` as the untrusted assistant-text renderer, and `ui-conversation` selects it only for assistant `text` blocks. Finalized history, the streaming tail, and interrupted partials already share `AssistantMarkdown`, so they receive the same renderer without changing events or snapshots. User and steering messages keep `MessageText` and remain literal.

`MarkdownText` uses `react-markdown` with `remark-gfm` to build React elements from an AST. It covers CommonMark blocks plus GFM tables, task lists, strikethrough, and autolinks without `dangerouslySetInnerHTML`, raw-HTML parsing, or syntax highlighting. The dependency is explicit in `ui-primitives`; because that pure library is seeded by the Web shell, the parser is part of the initial browser bundle.

## Untrusted output policy

Assistant-authored destinations are restricted to absolute HTTP, HTTPS, and mailto URLs. HTTP(S) links open in a new tab with `rel="noopener noreferrer"`; relative destinations and other protocols render as non-navigable text. Markdown images render only their alt text, so model output cannot initiate a remote image request. Raw HTML remains inert source text because no HTML parser enters the pipeline.

The renderer uses existing `--dsw-*` typography and color tokens. Fenced code and GFM tables own horizontal overflow so long content cannot widen the conversation column.

## Alternatives considered

**Promote the existing mdast and micromark development dependencies and maintain a custom React walker.** This avoids a new parser family but makes the product own every node mapping, GFM extension, and security-sensitive rendering branch. The dedicated React renderer keeps that traversal upstream while preserving an AST-to-React path.

**Replace `MessageText` with Markdown rendering.** This formats user prompts and steering as a side effect. Those authored surfaces remain literal until the product chooses that behavior explicitly.

**Parse Markdown into session snapshots.** This would make React nodes or presentation ASTs durable runtime state and reintroduce a final-versus-streaming mode boundary. Parsing stays at the presentation leaf instead.

**Enable raw HTML or remote images with sanitization.** Neither capability has a current product need, while both enlarge the executable or network privacy boundary. They remain disabled rather than adding sanitizer and image-policy dependencies.

## Consequences

Assistant replies render semantic Markdown consistently during streaming and replay, while tool cards, reasoning rows, interactions, user bubbles, and the host protocol remain unchanged. Streaming reparses the current text after each accumulated update; incomplete Markdown can temporarily change structure, but the isolated tail bounds React invalidation and the final event does not switch renderers. The initial Web shell grows by the Markdown parser and GFM runtime, and future extensions such as syntax highlighting or remote media require a separate bundle and security decision.
