# Agent Note: The no-Workspace composer opens the existing picker

Status: implemented

English | [中文](2026-08-07-workspace-picker-composer-entry.zh.md)

## Problem

The [session-scope decision](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) keeps one resident composer before a Workspace exists, but its textarea was disabled and only the smaller Workspace chip could open the picker. The largest and most familiar starting affordance therefore rejected the user's first click even though a recovery action was available on the same surface.

## Decision

While no Workspace owns the new Session, the resident textarea is read-only and activates the existing `conversation.hero.workspace` picker by pointer click, Enter, or Space. It exposes menu expansion state through `aria-haspopup` and `aria-expanded`. Message submission, command, permission, model, and other Session-scoped controls remain locked until Workspace selection creates or reconnects a real Session.

Workspace selection retains the existing owner and flow. `ConversationRoot` opens the picker, `WorkspacePicker` lists or creates the Workspace, and the same textarea DOM node becomes the editable composer after the Session arrives.

## Alternatives considered

**Keep the textarea disabled and emphasize the Workspace chip.** This preserves the old control boundary but leaves the dominant composer surface inert during the first action.

**Place a transparent button over the textarea.** A button has direct trigger semantics, but it creates a second focusable element over the resident textarea and complicates the DOM-identity transition that preserves focus, IME, and draft behavior.

**Accept a draft before Workspace selection.** This would require a client-owned draft Session or another pre-Session state axis. The feature only needs a discoverable path into the existing picker.

## Consequences

The first composer click now continues the required setup flow, and keyboard users can activate the same path. The textarea accurately reports read-only state until a Session exists, while adjacent controls remain disabled. The UI introduces no new Workspace state, transport, or directory-selection flow.

Component coverage pins pointer and keyboard activation, locked adjacent controls, picker expansion, and the same-node transition to an editable textarea. The assembled Web helper begins fresh Workspace setup through the textarea, so replayed browser scenarios exercise the shipped path.
