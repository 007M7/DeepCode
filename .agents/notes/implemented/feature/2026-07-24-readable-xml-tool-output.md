# Agent Note: Readable XML tool output

Status: implemented

English | [中文](2026-07-24-readable-xml-tool-output.zh.md)

## Problem

Model-facing context and tool result text can expose transport-oriented XML wrappers instead of the information people need. Context producers do not declare presentation intent, and replayed tool calls whose definition is unavailable still need a conservative fallback that does not reinterpret ordinary prose or partial markup.

## Decision

The read tool declares a generic completed-result presentation that removes its `<path>`, `<type>`, and `<content>` wrapper while preserving the numbered content and footer. This tool-owned projection applies consistently to every UI that consumes tool presentation intent.

The TUI parses a context message or unavailable-tool result as XML only when the complete text is one supported XML document. It renders element names and attributes as an indented tree, preserves the context source label, applies the collapsed line budget independently to each tool result's top-level child lines and child count, and keeps raw text for malformed XML, mixed text, declarations, processing instructions, doctypes, and comments. A known tool's raw XML remains literal unless that tool declares its own result presenter. This XML fallback is TUI-only.

## Alternatives considered

**Strip XML-like tags with regular expressions.** Rejected because nested elements, attributes, entities, and malformed input require a real parser; partial conversion would make ambiguous output harder to inspect.

**Parse every generic result.** Rejected because known tools own their presentation contract, and silently reinterpreting their literal XML would override that decision.

**Show only raw XML.** Rejected because wrappers optimized for model consumption add terminal noise, particularly for filesystem reads and deeply nested structured results.

## Consequences

Filesystem reads are shorter in TUI cards without changing canonical model-facing content. Complete XML context messages, including workspace instruction reminders, become readable trees; unknown complete XML results become navigable trees and retain per-child context when collapsed. The TUI adds a strict SAX parser dependency and deliberately declines XML features (undefined entities, DOCTYPE, comments, processing instructions) that could hide or transform input beyond the conservative tree view. Predefined entities and character references do expand, so parsed text and attribute values are re-escaped for terminal output after parsing: a character reference can produce a control character that escaping the raw source never saw. Other UIs show raw generic content.
