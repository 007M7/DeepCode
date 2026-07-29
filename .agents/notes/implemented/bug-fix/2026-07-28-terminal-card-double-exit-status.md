# Agent Note: The terminal card reported a non-zero exit twice

Status: implemented

English | [中文](2026-07-28-terminal-card-double-exit-status.zh.md)

## Problem

A failing `bash` call rendered its exit status twice:

```
● Tool / bash / Check merge lock and flock availability
$ … ; grep -n "merge.lock" .gitignore
/opt/homebrew/bin/flock
[exit code: 1]
[exit 1]
```

`renderResult` appends `[exit code: N]` to the model-facing text because the model reads a single string and must see the exit. `presentBashResult` then returned that same string verbatim as the terminal card's `output` while also parsing the marker into `exitCode`, and the TUI renders `output` followed by its own dim `[exit N]` pill. Every non-zero exit and every signal kill therefore printed both forms.

Neither producer was individually wrong: `TerminalResultView` documents `output` as the captured command output and `exitCode`/`signal` as separate structured fields precisely so a capable UI can show a pill. The bug was that `presentBashResult` put the consumed marker in both places. The TUI's own snapshot fixtures hid it — the hand-built card fixture supplies a marker-free `output`, and the one real recorded bash journey (`bash-terminal-card`) runs `echo TERMINAL_OK`, which exits 0 and so emits no marker at all.

## Decision

`parseExitStatus` now returns `{ body, …exit }`: it splits the rendered text at the marker it anchors on, so the caller receives the output body without the status line it consumed. `presentBashResult` passes that body as the card's `output`. Only the exit/signal marker leaves the output; `[output truncated: …]`, `[timed out after Nms]`, and the sandbox denial and escalation lines stay in the body because they carry facts no exit pill shows.

The split lives in `render.ts` next to the marker emission it inverts. Emission, parse, and strip already had to co-evolve in one file, and a round-trip test pins the trio.

## Alternatives considered

- **Drop the `[exit N]` pill in the TUI.** Rejected: the pill is the scannable status, styled and placed independently of command output, and it is the only exit signal a card gets for a `TerminalResultView` produced by a tool other than `bash`.
- **Strip the marker in the TUI renderer.** Rejected: the renderer would have to know `dsh-tool-bash`'s marker vocabulary, and the strip belongs with the parse that already consumes it. A tool's render intent is the tool's to define.
- **Stop emitting the marker from `renderResult`.** Rejected: the marker is the model's only exit signal in a single text result, and the `tool:bash` prompt section teaches the model to check it.
- **Have `execute` return a structured exit alongside the text.** Rejected: `presentResult(args, result)` is deliberately pure over content blocks so it replays from the session log, which retains only the rendered text.

## Consequences

A card body no longer ends in the marker, so a session replayed from the log renders the same single pill as a live run. The pre-existing display-only residual is now slightly larger and is recorded in the package README: output whose final line happens to be exactly `[exit code: N]` or `[killed by signal: …]` is read as the marker, which both shows a wrong pill and drops that line from the card body.

The deliberate treatments in [the tool-card header note](../feature/2026-07-27-tui-tool-card-header.md) are unchanged: terminal exit keeps its existing dim `[exit N]` line rather than moving into a uniform footer.

## Testing

`tools.spec.ts` pins the marker-free body for a non-zero exit, a signal kill, and a clean run; asserts a timeout marker survives alongside the stripped exit; and extends the `renderResult`/`parseExitStatus` round-trip to assert no consumed marker remains in the body.

The defect was invisible to every existing snapshot, so `tui-keyless-smoke.e2e.ts` adds a real-PTY scenario: the scripted adapter calls the real `bash` tool with `printf …; exit 3`, and the test asserts the terminal output contains the command's stdout and `[exit 3]` but never `[exit code: 3]`. It reproduces the double render when the presenter fix is reverted.
