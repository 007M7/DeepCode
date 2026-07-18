# RFC: Snapshot semantic terminal state for the TUI

Status: implemented

English | [中文](2026-07-18-tui-terminal-state-snapshots.zh.md)

## Problem

The TUI is a stateful renderer. Its user-visible result depends on ANSI parsing, differential frames, wrapping, scrollback, viewport position, terminal width, focus, cursor state, and each tool's presentation intent. Unit tests that collect `Terminal.write()` fragments can prove event handling, but they cannot prove the final screen a terminal displays. The same screen may also be emitted through different write fragments, so pinning those fragments creates false regressions.

Component-line snapshots stop before ANSI reaches a terminal and miss cursor movement, clearing, styling, overlay composition, and reflow. Raster screenshots include font and platform rendering noise that is unrelated to the TUI contract. The TUI therefore needs a deterministic, reviewable representation of terminal state plus a smaller test at the real process and PTY boundary.

## Decision

TUI coverage has three complementary layers:

1. `tui.spec.ts` tests event mapping, input routing, disposal, and error behavior directly.
2. `tui.snapshot.ts` mounts the production TUI against a headless terminal emulator and compares semantic terminal-state goldens.
3. `tui-keyless-smoke.e2e.ts` boots the real Loader composition in a PTY, drives a complete scripted conversation through streaming and `ask_user_question`, exits through `/exit`, and verifies terminal teardown. The production coding-agent configuration also retains its banner/exit and startup-failure PTY cases.

The package-local `HeadlessTerminal` implements the same pi-tui `Terminal` interface as the process terminal and feeds every ANSI write into the pinned `@xterm/headless` parser. A snapshot waits for pi-tui's synchronized-output end marker before reading state. This makes a checkpoint represent a completed frame rather than a timer-dependent write prefix.

Each golden projects terminal state into text: dimensions, active-buffer and viewport coordinates, lifecycle and cursor state, rows, wrap markers, and non-default style ranges. Scroll-heavy cards capture the used buffer; overlays capture the visible viewport. Text and style remain separate so a reviewer can distinguish content changes from presentation changes without decoding ANSI bytes.

Every checkpoint also enforces theme independence across the complete terminal state: no RGB colors, no palette entries beyond ANSI 0–15, and no explicit background colors. Reverse video remains valid for selection because it uses terminal defaults. The suite owns a closed checkpoint list: its type rejects undeclared names, and its inventory checks reject missing checkpoints and orphaned `.golden.txt` files.

### Required scenario matrix

| Area | Representative checkpoints | Contract pinned |
|---|---|---|
| Conversation | replay, streaming, completion | Resumed Markdown and reasoning, live deltas, plans, token usage, and max-token completion |
| Code Mode | pending and completed `run_code` | The production Code Mode registry and presenter, source program, captured logs, and result |
| Dynamic workflows | pending and completed `workflow` | The production workflow presenter, metadata, phases, parallel agents, script, and structured result |
| Cordis tools | pending and completed inspect/mount/unmount | The production `cordis_inspect`, `cordis_mount`, and `cordis_unmount` presenters and lifecycle results |
| Advanced tool cards | collapsed and expanded | Terminal, diff, generic, subagent, background-task, and skill card shapes plus output truncation |
| Interaction | question and validation | Constrained multi-select overlay composition, focus, scrolling, selection, and validation errors |
| Surface and layout | before compaction, narrow replacement, wide replacement | Surface replacement removes retired content; resize reflows the surviving surface without resurrection |
| Failure and shutdown | errors/help and disposed terminal | Help and unknown commands, live/turn error de-duplication, interruption, cursor restoration, and terminal stop |

The explicitly model-facing advanced cases use the real `ToolRegistry` configuration and the production Code Mode, workflow, and Cordis tool presenters. Synthetic presenter fixtures are limited to the generic card-shape matrix, where the TUI's input contract is the presenter view itself. Session events remain the driver so replay, streaming, result arrival, surface replacement, and lifecycle ordering exercise the same projection path as production.

The TUI suite is included by `vitest.snapshot.config.ts`, so `pnpm run test:snapshot` compares it keylessly. `pnpm run test:snapshot:refresh` rewrites its derived terminal goldens without contacting a model; `test:snapshot:record` remains meaningful for suites whose transcript source requires recording. Both refresh paths still compare the resulting files in the same run.

## Alternatives considered

- **Snapshot raw terminal writes** — rejected because differential rendering may change write boundaries without changing the screen, while cursor and clear sequences are unreadable in review.
- **Snapshot component render lines before terminal output** — rejected because it does not test ANSI parsing, cursor movement, overlays, viewport behavior, or the interaction between independent components in one frame.
- **Commit raster screenshots** — rejected because fonts, glyph metrics, antialiasing, and host terminal themes make them platform-sensitive and make semantic style changes difficult to review.
- **Use only PTY end-to-end tests** — rejected because raw PTY output is a stream of historical drawing operations, not queryable final state. PTY tests retain the real Loader/input/teardown boundary, while the emulator owns broad state coverage.
- **Copy pi-tui's unpublished virtual-terminal test helper** — rejected because the installed package does not export that helper. A small adapter around the public `@xterm/headless` API keeps the dependency explicit and the projection owned by this package.

## Consequences

- TUI visual regressions produce readable cell-and-style diffs, and the required matrix makes advanced features first-class rather than incidental coverage.
- The test dependency is pinned to the xterm version used by pi-tui. The adapter uses xterm's proposed buffer API, so an xterm upgrade requires rerunning and reviewing the semantic projection.
- The emulator models ANSI terminal state but cannot prove behavior unique to every terminal implementation. The real PTY conversation covers process selection, keyboard input, user interaction, and teardown without duplicating the full matrix.
- Goldens deliberately encode wrapping and viewport behavior at fixed sizes. Intentional layout changes update them through the keyless refresh command and receive ordinary snapshot review.
