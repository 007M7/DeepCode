# Agent Note: New Session clears onto the empty-state launch

Status: implemented

English | [中文](2026-07-24-new-session-clears-to-empty-state.zh.md)

## Problem

Sidebar "New Session" created and opened a blank session immediately, so the center column showed `ConversationRoot` with an empty transcript and the resident composer. The Figma NEW SESSION screen (`EmptyState` + shared `InputBar` hero) only rendered when `sessions.current` was already undefined, so the launch page was unreachable from the primary creation control.

## Decision

`SessionsService.clear()` wipes the persisted selection and `list.current`. Top-level sidebar creation entries (`onCreate()` with no cwd — New Session and New Workspace) call `clear()` so `AppFrame` renders `conversation.empty`. The empty state's first send still runs `conversation.startSession` (create → open → send) and reuses the same `InputBar` component as the resident composer (`variant="hero"`). Per-project "+" (`onCreate(cwd)`) keeps create-then-open until the empty-state picker can accept a seeded cwd.

## Alternatives considered

**Keep create-then-open for New Session and add a second empty chrome inside ConversationRoot when the transcript is empty.** Rejected: that duplicates the launch InputBar and breaks the empty→content ruling that one InputBar moves position rather than swapping components.

**Route New Session through a dedicated route or slot outside selection.** Rejected for this pass: `conversation.empty` already owns the launch UI; clearing `current` is the existing empty branch.

## Consequences

New Session no longer mints a host session until the first send. Reloading after clear stays on the empty state. Project-scoped "+" still creates immediately. `EmptyState` stacks the Figma hero as fish + title, a Menu-backed workspace chip ("New Workspace" / basename / free-form path) above the card, then shared `InputBar` (`variant="hero"`), with a soft ellipse glow (figma 313:14109) centered behind the picker + card and width-locked to the card (`1051/776`) so it scales with it. `InputBar` paints the bottom chrome (attach / Plan / Read-only / model) with local native `<select>` state only — host plan, access, and model seams remain unwired.
