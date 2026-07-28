# Agent Note: The prompt context combines directory and branch

Status: implemented

English | [中文](2026-07-24-tui-prompt-workspace-label.zh.md)

## Problem

The idle prompt context rendered the working directory and `git:<branch>` as separate segments. In task worktrees, the directory can already identify the checkout, while the prefixed branch segment consumed additional horizontal space and was discarded independently on narrower terminals.

## Decision

- The prompt context renders the working directory and available Git branch as one workspace label: `<directory> (<branch>)`.
- The directory remains bold and accented; the parenthesized branch remains muted.
- The combined workspace label has the highest retention priority and is clipped as one segment when it exceeds the terminal width.
- Outside a Git worktree or on detached HEAD, the label remains the directory alone.

## Alternatives considered

**Keep `git:<branch>` as a separate segment.** Rejected: the prefix and separator use more columns without adding meaning in this context.

**Show only the branch.** Rejected: the session working directory determines where tools operate and remains the primary prompt context.

**Derive a special worktree root label.** Rejected: the existing formatted directory and Git branch already provide the two relevant facts without adding repository-layout assumptions.

## Consequences

- A typical checkout renders as `~/git/tui-staging (tui-staging)`.
- Narrow terminals retain or clip directory and branch together instead of dropping the branch independently.
- Embedding-provided `TuiRuntime.formatCwd` labels compose with the branch in the same form.

## Testing

`packages/ui/tui/tests/tui.spec.ts` pins home, absolute, formatted, and narrow workspace labels. Package-local and runnable-example TUI snapshots verify the assembled prompt context.
