# Agent Note: Keep the TUI session identity visible

Status: implemented

English | [中文](2026-07-23-tui-footer-session-identity.zh.md)

## Problem

The startup banner identifies the active session, but it scrolls out of view during a conversation. Operators working with several resumable sessions then lack a persistent way to confirm which session receives their input.

## Decision

The TUI footer begins with the active session id, before the model, working directory, token counts, cache rate, and context use. It shows tool-card state only while cards are expanded; the default collapsed state adds no label. The session id uses the same control-character escaping as other terminal labels and participates in the footer's existing left-to-right clipping behavior.

The footer reads the id from the mounted agent's session, so fresh and resumed sessions use the same authoritative identity without separate UI state.

## Alternatives considered

- **Keep the identity only in the startup banner** — rejected because the banner leaves the viewport in longer conversations.
- **Show the session id only in `/status`** — rejected because an on-demand diagnostic does not let an operator confirm identity before sending input.
- **Put the session id in the right footer segment** — rejected because narrow terminals clip that segment first; session identity is more important than context and expanded tool-card state.

## Consequences

The current session remains identifiable while the editor is active. On narrow terminals, the longer left segment leaves less room for context and the expanded tool-card label, while the existing clipping policy preserves session identity, model, and as much operational context as fits.

Package coverage pins the footer ordering and escaping path, and the runnable TUI terminal snapshots pin the assembled layout.
