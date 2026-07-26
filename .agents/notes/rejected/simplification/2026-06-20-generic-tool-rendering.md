# Agent Note: Collapse tool-owned UI presentation

Status: rejected — TUI and the Web host/client runtime consume the tagged render-intent union, so tool-owned presentation remains current even though ACP no longer projects it.

English | [中文](2026-06-20-generic-tool-rendering.zh.md)

## Problem

The optional-field bag and ACP editor mapping below were the proposal-time context for this rejection. The current contracts live in [the tagged render-intent union](../../implemented/architecture/2026-07-02-tool-render-intent-union.md) and [automation-only ACP](../../implemented/simplification/2026-07-23-acp-automation-only-protocol.md).

Tools could define `presentCall()` and `presentResult()` callbacks that returned `ToolCallPresentation`, `ToolResultPresentation`, and optional `ToolTerminal` fields. The code itself flagged the design as muddy: title, kind, raw input, content, terminal cwd, terminal output, exit code, and signal had grown incrementally into a bag of optional fields. ACP then maintained pending call state to pair a result with the original args, created replay-only presenters on `session/load`, and mapped terminal subfields into Zed-specific `_meta`. `dsh-tool-bash` even parsed exit status back out of rendered text because the pure replay-safe presenter no longer had the structured `BashRunResult`.

The real first-party use was bash presentation for ACP. That was too little evidence to freeze a cross-package UI presentation API.

## Proposal

Remove tool-owned UI presentation callbacks for now. The canonical tool events already carry the tool name, raw argument string, result content, and error state. UIs render a generic tool card from those fields. Tool-specific rich rendering can return later as a tagged render-intent union after there are at least two real tools and two real consumers to validate the vocabulary.

## Alternatives considered

As a smaller alternative, replace the current optional-field bag with one explicit union in a single PR; but if the goal is simplification, the stronger move is to delete the callbacks and keep the generic path.

## Acceptance criteria

- `ToolDefinition` drops `presentCall` and `presentResult`.
- `ToolCallPresentation`, `ToolResultPresentation`, `ToolTerminal`, and `ToolCallKind` disappear unless a minimal generic UI type still needs one.
- ACP no longer keeps presenter pending state or calls tool callbacks during live streaming/load replay.
- `dsh-tool-bash` no longer parses rendered text to recover exit status for a UI pill.
- Snapshot expected outputs show generic tool cards and text results.

## What we give up

Under this proposal, Bash would lose its custom terminal-looking card and model-written description placement. The fallback would remain reasonable: the command would appear as tool input, and the output as text. Rich rendering would be designed when the product had enough UI/tool variety to justify a stable presentation contract.

## Related

The later [tagged render-intent union](../../implemented/architecture/2026-07-02-tool-render-intent-union.md) implements the smaller alternative once multiple producer and consumer families provide enough evidence for the vocabulary. [Automation-only ACP](../../implemented/simplification/2026-07-23-acp-automation-only-protocol.md) removes ACP's editor projection without removing tool-owned presentation from TUI or the Web host/client runtime.
