# Agent Note: fail-loud releases the terminal before exiting

Status: implemented

English | [中文](2026-07-31-fail-loud-releases-the-terminal.zh.md)

## Problem

A `dsh` launch whose config failed validation printed its diagnostic and returned the user to a broken shell. Typing was invisible, and the next command was mangled by stray text:

```
dsh: fatal load failure: ValidationError: invalid config:
  - $.providers expected object but got [object Object] (at providers)
$ 1;2;4cecho hello
zsh: command not found: 4cecho
```

The Loader mounts entries concurrently, so entry failure order is not startup order. `ui-tui` activates and calls pi-tui's `ProcessTerminal.start()`, which puts stdin in raw mode, enables bracketed paste, and writes the Kitty keyboard-protocol probe — a sequence ending in a Device Attributes query (`ESC [ c`). A sibling entry (here `llm-pi-ai`) then rejects on its own config. That rejection surfaces as an unhandled rejection, and `installFailLoud` wrote one stderr line and called `process.exit(1)` immediately.

Nothing disposed the tree, so `ProcessTerminal.stop()` never ran: raw mode, bracketed paste, and the keyboard protocol stayed set on the shell that outlived the process. The terminal's answer to the Device Attributes query (`1;2;4c`) arrived after exit and was read by the shell as typed input — the literal text above.

The `/exit` path was never affected, because it disposes the tree and reaches the TUI's own `shutdown()`, which calls `drainInput()` (absorbing the pending reply) and then `ui.stop()`. The defect was that a *failed boot* had no path to that same teardown.

## Decision

`installFailLoud` takes an optional `release` teardown, awaited between the diagnostic and the exit:

- The diagnostic is written **before** the release, so the reason survives a disposer that repaints or clears the screen.
- The handler uninstalls itself before releasing. Teardown runs plugin disposers that may themselves reject, and a re-entered handler would report a cleanup failure as a second fatal load failure, burying the real one.
- The release is bounded by `FAIL_LOUD_RELEASE_TIMEOUT_MS` (2s) and its rejection is swallowed. A wedged or failing disposer delays the fatal exit; it never cancels it.
- Omitting `release` keeps the previous behavior exactly, so the ACP, JSON-RPC, and demo bins are unchanged.

`dsh`'s TUI launcher passes a release that disposes the root context, which runs the TUI's existing `shutdown()` and hands the terminal back.

The launcher captures the root context in `boot()`'s `prepare` hook rather than from its return value. The rejection arrives while `boot()` is still in flight, so `app.current` assigned after the `await` would still be `undefined` at exactly the moment the hook needs it. `prepare` runs after the Loader installs and before any config-tree entry mounts, which covers the whole window in which an entry can reject.

## Alternatives considered

**Reset the terminal from the fail-loud handler** (write `ESC [ ? 2004 l`, pop the keyboard protocol, clear raw mode). This duplicates pi-tui's teardown in a package that owns no terminal, and would drift as pi-tui's startup sequence changes. It also cannot absorb the in-flight Device Attributes reply, which is what corrupts the next prompt — only draining stdin while it is still raw does that.

**Register a `process.on('exit')` terminal reset in the TUI.** Exit handlers are synchronous, so they cannot await `drainInput()`; the stray reply would still land. It also puts teardown on a global hook rather than the disposal path that already exists.

**Have the TUI refuse to start until the tree settles.** This serializes a deliberately concurrent Loader and delays first paint for every healthy launch to fix a failure path.

**Reorder config entries so `llm-pi-ai` mounts before `ui-tui`.** Ordering is not a guarantee the Loader makes, and any future entry could fail after the TUI mounts.

## Consequences

A failed boot now costs one tree disposal (bounded at 2s) before exit, and the exit code stays 1. In exchange, a misconfigured `dsh` returns a usable shell instead of one needing `stty sane` or `reset`.

The guarantee belongs to whichever bin owns the terminal: a surface that grabs terminal state and does not pass `release` reintroduces this defect. `installFailLoud` cannot detect that on its own, since it has no view of what a mounted plugin did to the process.

## Testing

`packages/ui/app-boot/tests/app-boot.spec.ts` covers the release contract: the hook is awaited before the exit commits, a rejecting hook still exits 1, a never-settling hook exits after `FAIL_LOUD_RELEASE_TIMEOUT_MS` under fake timers, and the handler is uninstalled before releasing so teardown cannot re-enter it.

The end-to-end symptom is terminal state after process exit — what the *shell* sees once `dsh` is gone — which no in-process assertion observes. It was verified manually in tmux against a config with a list-shaped `providers` value: before the change the next command was mangled (`zsh: command not found: 4cecho`); after it, the diagnostic is intact, the exit code is 1, and the next command runs normally. The `/exit` path was re-checked to confirm the goodbye line and exit code 0 are unchanged.
