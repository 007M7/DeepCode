# Agent Note: Web turn run time and hover-revealed time chrome

Status: implemented

English | [中文](2026-08-03-web-turn-run-time.zh.md)

## Problem

The Web chat shows when a message arrived but not how long the agent worked on it. Long turns give no live progress signal beyond the static activity label, and after the turn settles the wall time is not recoverable from the UI. Meanwhile the always-visible clock row adds visual noise to every message.

## Decision

Turn wall time derives from adjacent logged timestamps, with no new session events: `turnStartTimes` maps each turn to the nearest preceding user/steering node's time, and the actions-owning assistant footer renders `time - turnStart` as a `Ran for {duration}` label next to the clock. The running `TurnStatus` label gains a live elapsed clock anchored to `lastInputTime` — the same logged instant the footer measures from — so a mid-turn reload keeps the real elapsed time and the final label matches the live clock. The clock appears only after 15 seconds so short turns keep the plain label.

Time chrome (clock and run time) is hover-revealed: message containers opt in with a `data-time-hover-root` attribute, and `MessageIconActions.module.css` fades the time label in on container `:hover`/`:focus-within`. The rule is scoped to `@media (hover: hover)`, so touch devices keep the always-visible label; opacity (not display) keeps the layout stable. Copy/branch icons stay always visible.

## Alternatives considered

**A dedicated turn-start session event.** Precise, but adds a model-invisible event type solely for UI display; the adjacent-timestamp fold matches the trajectory table's existing derivation family and needs no log change. A turn whose trigger is outside the loaded window simply omits the label.

**Anchoring the live clock to component mount.** Simpler, but a mid-turn reload would restart the clock at zero and disagree with the eventual footer label. Mount time remains only the fallback when no input node is in-window.

**Hiding the whole actions row until hover.** Rejected in review: copy/branch are affordances worth discovering, and row-level show/hide risks layout shift. Only the passive time text is hover-gated.

## Consequences

Turn duration is visible live and after settlement without new session state, and the two readings agree by construction. The run-time label is absent for turns whose triggering input fell outside the loaded window. Time chrome no longer competes with message content at rest; ARIA-tree snapshots are unaffected because the label stays in the DOM.
