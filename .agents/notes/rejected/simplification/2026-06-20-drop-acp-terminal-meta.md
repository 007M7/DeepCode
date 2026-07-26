# Agent Note: Drop ACP terminal `_meta` rendering

Status: rejected — removing only Zed terminal metadata was rejected while ACP remained an editor bridge; automation-only ACP later removed the whole editor projection.

English | [中文](2026-06-20-drop-acp-terminal-meta.zh.md)

## Problem

The former ACP editor bridge implemented a Zed-specific terminal-card convention through `_meta.terminal_info`, `_meta.terminal_output`, and `_meta.terminal_exit`. The current [render-intent decision](../../implemented/architecture/2026-07-02-tool-render-intent-union.md) preserves the underlying rule that bash execution belongs in the harness and terminal cards are display-only. The later [automation-only ACP decision](../../implemented/simplification/2026-07-23-acp-automation-only-protocol.md) removes the `_meta` projection, bridge state, capability negotiation, terminal ids, special update mapping, text fallback tests, and exit-pill parsing from ACP. TUI and the Web host/client runtime retain the tagged presentation contract, while ACP no longer renders editor cards.

At proposal time, the fallback path already existed: render the tool call and completed output as normal ACP content blocks. Non-Zed clients relied on that path, but the Zed terminal card was a target-client feature rather than speculative decoration.

## Proposal

Ignore `clientCapabilities._meta.terminal_output` and render bash results through the plain ACP content path. Keep execution agent-side through `dsh-bash`; only the display-specific terminal metadata is removed. A terminal card can return later if ACP standardizes agent-executed terminals or if the product decides Zed-specific display is worth the maintenance cost.

This proposal is narrower than [collapsing tool-owned UI presentation](2026-06-20-generic-tool-rendering.md): it keeps generic `presentCall`/`presentResult` if those survive, but removes the terminal sub-shape and `_meta` mapping.

## Acceptance criteria

- ACP no longer reads or stores `_meta.terminal_output` capability state.
- `TerminalRendering`, terminal ids, terminal cwd resolution, and `_meta.terminal_*` update mapping disappear from `@deepseek-ai/dsh-acp`.
- `ToolTerminal` disappears from `@deepseek-ai/dsh-tools`, or is unused and deleted with the presentation cleanup.
- Bash result presentation no longer parses exit status for terminal pills.
- The [automation-only ACP decision](../../implemented/simplification/2026-07-23-acp-automation-only-protocol.md) later removes ACP terminal cards and absorbs their execution-ownership rationale.

## What we give up

Under this proposal, Zed users would lose the dedicated terminal card: no cwd header, terminal display, or exit pill. They would still see the command and output as plain content. That was a reasonable simplification to consider while the ACP bridge was unreleased and the `_meta` keys were a convention rather than a standard.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
