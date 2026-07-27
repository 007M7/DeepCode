# Agent Note: Trajectory inspection ledger

Status: implemented

English | [中文](2026-07-27-trajectory-inspection-ledger.zh.md)

## Problem

Trajectory has to make prose, machine payloads, token usage, timing, and nested tool activity readable in the same viewport. The earlier stacked Turn and Step cards preserved hierarchy but spent too much vertical space on repeated chrome, while a completely flat table would erase the causal structure that makes a trajectory useful. Role colors also risked borrowing success and warning semantics, which made visual decoration indistinguishable from runtime state.

## Decision

**Render a compact, turn-aware event ledger with a local record inspector, using the existing DeepSeek design system.**

- Turn boundaries are thick rules between record rows, while each Step appears as a compact inline marker on its first record. Individual User, Assistant, Tool, and Subtool events share stable columns for index, event kind, and content; token usage and duration stay in the inspector, a thin timeline rail preserves sequence, and nested subtools receive a small indentation.
- Product prose continues to use the existing sans stack. Record indexes, token counts, durations, group summaries, tool calls, and raw payloads use the existing code stack because they are machine data.
- Existing semantic theme tokens own both light and dark rendering. Neutral borders and surfaces form the structure; business blue is limited to Assistant identity, selection, links, and focus; warning is limited to running work; error is limited to failed work. User and Tool roles do not impersonate runtime states.
- Entity surfaces stay flat and separated by hairline borders. Shadow appears only when the inspector becomes an overlay at narrow widths.
- Selecting a record opens an inspector inside Trajectory with Overview, Input, Output, and Timing tabs. This state is deliberately independent from the conversation-wide Chat details column: it inspects a trajectory record without changing the user's Chat context.
- The three-column ledger reserves its width for record content. At narrow widths the inspector overlays the ledger and remains dismissible by keyboard or pointer.

## Alternatives considered

**Copy Vite DevTools fonts, colors, glass surfaces, or component shapes.** Rejected: those choices express a different product identity. The implementation only adopts the transferable method: neutral structure, semantic accents, machine-data typography, dense scanning, and shadows reserved for floating layers.

**Keep one card per Turn and Step.** Rejected: repeated card chrome reduced the number of visible records and made cross-step comparison slower.

**Flatten every record without turn rules or step markers.** Rejected: a trajectory is not merely a log stream; Turn and Step boundaries are essential causal landmarks even when they do not consume dedicated rows.

**Reuse the global Chat details column.** Rejected: it would couple local inspection to conversation navigation and make a row click unexpectedly change another view's state.

**Change global theme tokens to match the reference.** Rejected: the existing theme already provides paired light and dark semantic layers, and a local redesign does not justify changing unrelated surfaces.

## Consequences

Trajectory shows more useful records per viewport while retaining Turn and Step orientation. The main ledger omits token usage and duration so content receives the available width; the local inspector exposes those facts together with full payload and assistant timing. The inspector floats over the table only when a permanent split would make both panes unusable. Focused component tests pin the ledger, fold control, keyboard selection, payload tabs, timing facts, and running/error semantics; the assembled Web snapshot pins the real seeded session with the local inspector open.
