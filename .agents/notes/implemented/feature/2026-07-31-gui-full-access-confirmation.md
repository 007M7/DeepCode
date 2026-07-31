# Agent Note: GUI Full access risk confirmation

Status: implemented

English | [中文](2026-07-31-gui-full-access-confirmation.zh.md)

## Problem

Switching the web client to `danger-full-access` was a single click on either permission surface (the composer's Access chip and the `/permission` popup picker), with the preset shown as the title-cased machine name `Danger Full Access`. Full access reduces confirmation steps and lets the agent run sensitive operations, modify files, or execute external commands, so an accidental pick armed the most dangerous preset with no deliberate acknowledgement step.

## Decision

**Both permission surfaces gate `danger-full-access` behind one shared in-page `RiskConfirmation` dialog whose enabling action stays disabled until an explicit acknowledgement checkbox is checked; the preset renders under the product label `Full access`; every dismissal path submits nothing.**

- `RiskConfirmation` (ui-primitives) is a controlled Modal composition: title, description, acknowledgement checkbox, cancel, and a confirm button disabled until `acknowledged`. It stays an in-page dialog — the Modal portals to this document's body and never opens a native or separate browser window that could land on another display. `Modal` gains a `contentClassName` seat so the warning body scrolls inside constrained mobile/landscape viewports while the action row stays fixed.
- The composer chip (`PermissionSelect`, ui-conversation) intercepts a Full-access pick before the `/permission` submit: `confirmation`/`acknowledged` component state opens the dialog, confirm submits `/permission danger-full-access` through the same injected `command` path as every other pick, and cancel/Escape/close/mask leave the current preset untouched with the checkbox reset. The confirmation revokes itself when the session locks (`locked`/value-absent effect) and resets across task switches (`key={sessionId}` remount). Copy rides the standard `conversation` locale seat as `access.confirm.*` keys.
- The `/permission` popup (ui-permission over the ui-command shell) gates through data, not a second dialog implementation: `SelectOption` grows an optional `confirmation` payload, the popup controller owns the `confirming`/`acknowledged` state transitions, and `PopupSelectView` swaps the picker card for the same `RiskConfirmation` while a gated option is pending.
- `Full access` intentionally overrides the kebab-to-title display transform on both surfaces (option rows, trigger label, settled command rows keep the machine name on the wire); the warning body remains locale-aware in Chinese and English.

## Alternatives considered

**A native/OS or separate-window confirmation.** Rejected: the dialog must stay inside the current WebUI window; a second window can appear on another display and detaches the decision from the page state it guards.

**One shared locale namespace for both surfaces' safety copy.** Rejected: the ui-permission bundle and ui-conversation load independently, so each registers the same copy under its own namespace (`permission.access` beside the conversation dictionary); the duplication is fenced with an explanatory `jscpd:ignore` block rather than a cross-bundle import.

**Gating in the host/permission backend.** Out of scope by design: the change is browser-client confirmation flow only; backend permission semantics, defaults, and the safer presets' one-click behavior are unchanged.

## Consequences

Every visible GUI path into Full access now requires a deliberate, informed acknowledgement, at the cost of one extra dialog step for users who genuinely want the preset. New pickers reuse the gate by attaching a `confirmation` payload (popup path) or the chip's state machine (composer path) instead of inventing bespoke dialogs. Acceptance: the composer flow's four gated cases in `input-bar.spec.tsx`, the popup gate in `popup-view.spec.tsx` and `popup.spec.ts`, the Modal/RiskConfirmation contract in `atoms.spec.tsx`, and the assembled `access-confirmation` web e2e whose golden pins the product-default Chinese dictionary copy.
