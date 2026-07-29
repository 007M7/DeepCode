# Agent Note: Trajectory inspection ledger

Status: implemented

English | [中文](2026-07-27-trajectory-inspection-ledger.zh.md)

## Problem

Trajectory has to make prose, machine payloads, token usage, timing, and nested tool activity readable in the same viewport. The earlier stacked Turn and Step cards preserved hierarchy but spent too much vertical space on repeated chrome, while a completely flat table would erase the causal structure that makes a trajectory useful. Role colors also risked borrowing success and warning semantics, which made visual decoration indistinguishable from runtime state.

## Decision

**Render a compact, turn-aware event ledger with a local record inspector, using the existing DeepSeek design system.**

- The ledger keeps session events in sequence within rewind-delimited branches. Turn boundaries use a slightly heavier rule, the raw Turn id, and a continuous left rail; Request boundaries appear as small points integrated into that structure and use one chronological numbering space across ordinary and compaction requests.
- Event kind and content form the two stable columns. Role tags align toward the content, nested subtools receive a small indentation, and CSS truncation preserves the available preview width. Token usage and duration stay in the inspector.
- Product prose uses the existing sans stack. Turn ids, token counts, durations, tool calls, raw payloads, and other machine data use the existing code stack.
- Existing theme tokens own both light and dark rendering. Neutral borders and surfaces form the structure; distinct low-emphasis role hues support scanning without carrying success or failure meaning, while business blue identifies selection, links, and focus.
- The client runtime exposes a read-only history source independent from Session and SessionManager. Each activated source owns its raw entries, paging, live gap repair, and reconnect rebuild; the ordinary conversation snapshot remains the folded Chat projection. Trajectory subscribes to that source, exhausts its paging only while mounted, and lazily derives its event order, context lineage, schema index, and Requests instead of imposing those structures on every conversation consumer.
- Ordinary generation and compaction calls form one chronological Request projection, distinguished by purpose rather than separate collections. Effective prompt state and its change ride the Request that introduced them; compaction and prompt changes are not independent inspection entities. Complete history makes global Request numbering and cumulative usage session-wide rather than tail-window-relative.
- Call schemas come from the active recorded Request header. Keyless snapshot fixtures deliberately replace that catalog with the non-array `{{tools}}` token, which the durable inspection boundary treats as unavailable instead of attempting to project or fabricate schemas.
- Selecting a record or Request opens an inspector inside Trajectory. Tabs and Summary sections follow the selected entity: Markdown messages expose rendered, source, provenance, and hierarchy views; tools add JSON payload/result and schema views; Requests add options, usage, timing, and result navigation. Images render as media rather than serialized data.
- Turn folding removes all rows after its first record and replaces them with a compact step/tool-call count; Assistant folding applies the same interaction to its tool-call descendants. Global controls fold or expand both levels.
- The separate Waterfall tab is removed. A fixed Overview above the ledger projects every record with known `startedAt` onto three semantic timing lanes using its own duration. Dragging left or right commits an inclusive interval filter: any record whose active interval overlaps either boundary remains visible, records without known timing leave the focused ledger, and clearing the selection restores the full branch. The Overview keeps the full time domain while focused so the selection can be resized or cleared without losing orientation.
- This local inspector remains independent from the conversation-wide Chat details column. At narrow widths it overlays the ledger and remains dismissible by keyboard or pointer.

## Alternatives considered

**Copy Vite DevTools fonts, colors, glass surfaces, or component shapes.** Rejected: those choices express a different product identity. The implementation only adopts the transferable method: neutral structure, semantic accents, machine-data typography, dense scanning, and shadows reserved for floating layers.

**Keep one card per Turn and Step.** Rejected: repeated card chrome reduced the number of visible records and made cross-step comparison slower.

**Flatten every record without Turn or Request boundaries.** Rejected: a trajectory is not merely a log stream; those boundaries preserve the causal structure without consuming dedicated rows.

**Reuse the global Chat details column.** Rejected: it would couple local inspection to conversation navigation and make a row click unexpectedly change another view's state.

**Keep timing in a separate Waterfall tab.** Rejected: the placeholder summarized node counts rather than record timing and forced users to switch away from the rows they wanted to focus. A full-domain Overview keeps timing and filtered records in one visual context.

**Change global theme tokens to match the reference.** Rejected: the existing theme already provides paired light and dark semantic layers, and a local redesign does not justify changing unrelated surfaces.

## Consequences

Trajectory shows more useful records per viewport while retaining Turn and Request orientation. Context rewrites and compactions remain inline with their surrounding history, while a rewind begins a successor branch that inherits only the retained prefix. The main ledger omits token usage and duration so content receives the available width; the local inspector exposes those facts together with full payloads, provenance, schemas, and request timing. The Overview uses recorded start/duration facts without fabricating live elapsed time, and its inclusive focus behavior matches the interaction users already know from Chrome DevTools Network. Focused component tests pin projection, folding, record and interval selection, entity-specific tabs, and running/error semantics; the assembled Web snapshot pins the ledger, Overview, and inspector through the real client composition.
