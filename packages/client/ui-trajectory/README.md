# @deepseek-ai/dsh-client-ui-trajectory

English | [中文](README.zh.md)

Trajectory renders a turn-aware event ledger with selectable User, Assistant, Tool, and nested Subtool records. Thick rules mark Turn boundaries, compact inline markers identify Steps, and the main ledger keeps only index, event, and content; selection opens a local inspector for token usage, duration, Input, Output, and Timing. A standalone compaction request appears chronologically in its own `Between turns` section, while a numbered compaction remains inside its owning turn. Long ledgers open at the current tail, load one older page when the user reaches the loaded range's top, and mount only the visible row window plus a small overscan; selection, timeline navigation, folding, search, and Request totals cover the currently loaded window. The ledger covers records with an explicit loading row until the initial tail is positioned and while an older page is pending. A fixed Overview above the ledger projects real record start/duration timing from left to right; when earlier records remain unloaded and the viewport includes the loaded domain's start, a neutral ellipsis control identifies the omitted prefix and loads one earlier page without assigning unknown history fabricated duration. Assistant spans divide recorded TTFT from decoding, and a 500 ms hover reveals exact clock and duration details. Dragging an interval focuses the ledger on every record active at any point in that inclusive range, while clearing the selection restores the full branch. Wheel gestures zoom the time domain. A right-button click clears the selected interval, while a right-button drag pans an already zoomed viewport without changing it. The initial view and streaming updates stay at the tail; scrolling upward suspends following so new records do not interrupt inspection of earlier rows. Trajectory asks the conversation shell to float the composer over the full-height ledger, while its responsive vertical scrollers reserve the composer's live height so final rows remain reachable. The runtime's independent history source supplies raw context lineage and projects cancellation-frozen Assistant and Tool records, so Trajectory neither reads nor changes the Chat conversation snapshot. The package remains a pure-consumer plugin (registers one view tab into the conversation's `'conversation.view'` slot ring, provides no service, declares no Context merge). Contract: api-contracts v3 §8.

## Model Experience

None, as the trajectory views render session data in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **In-flight Time stays blank** — `partial` / `runningCalls` rows show their running state without a fabricated duration until a live clock policy lands, so the Overview renders a start marker rather than inventing a live span; record and timeline selection are intentionally local to Trajectory; anchor deep-linking remains deferred.
