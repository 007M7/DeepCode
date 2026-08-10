# Agent Note: The slash catalog follows a blank session's preset switch

Status: implemented

English | [中文](2026-08-10-slash-catalog-follows-preset-switch.zh.md)

## Problem

Presets moved the rows that decide what a session's `/` menu contains. The Web composition disables host-plane `skill-local`, `tool-skill`, `plan-mode`, and `command-compact`; a preset supplies them, so which commands and skills exist is a property of the session's composition rather than of the deployment.

Both browser catalogs cache per session — `CommandDirectory` in `dsh-client-ui-command`, the single-flight fetch map in `dsh-client-ui-skill` — and the composer warms both at scope birth, under whatever preset the session was created with. The hero chip then lets the user recompose the still-blank session, and neither cache had an invalidation edge for that: `commands/changed` is registry-wide and `connection/reset` needs a reconnect. `agentPresets.recompose` re-parents the agent's scope onto a standing mount that may already exist, so it registers nothing and the registry-wide signal never fires for it.

The menu therefore kept serving the composition the session no longer ran. Switching down left `compact`, `plan`, and every project skill listed; switching up left the narrower catalog — the four host-plane rows and the client's own `model` contribution — with no skills at all, which is what the bug report described. The catalog only healed when an unrelated registry change or a reconnect happened to invalidate it.

## Decision

The switch's commit point is the logged `agent-preset/selected` event. The host stream frames it as `host/session-preset-changed { sessionId, agentPreset }`, the browser runtime bridges that frame to the typed `session/preset-changed` ctx event beside the registry-invalidation bridges it already owns, and each catalog owner drops its own entry for that session: `ui-command` soft-refreshes the key (the old snapshot keeps serving the open menu until the new one lands), `ui-skill` invalidates it (aborting an in-flight prewarm, so a warm racing the switch cannot publish the stale catalog).

The frame is per session and carries no catalog. Deriving it from the logged event rather than from the RPC handler's return keeps one authority for "this session's composition changed": every connected client observes the switch, not only the tab that issued it, and a client that is not the switcher never has to infer it from a registry signal that will not come.

## Alternatives considered

**Invalidate in the client's own `agentPresets.select` callback.** Smallest change, and the preset is locked after the first turn, so the hero chip is the only place a switch can originate. Rejected because the invalidation would then live in the surface that happens to issue the RPC rather than at the commit point: a second tab on the same blank session keeps a stale menu, and any future host-side recomposition has no signal at all.

**Derive the client event from the existing `session/event` mux frame.** The logged event already reaches every subscribed client, so no new wire type would be needed. Rejected on face separation: narrowing `event.type` to `agent-preset/selected` requires the `SessionEventMap` augmentation, and the only ways to load it in the Client program are a project reference to `dsh-agent-presets` — which drags the host `ctx.sessions` merge into a program that publishes its own — or a cast that defeats the discriminant.

**Reuse `host/commands-changed`.** It is the existing catalog-invalidation frame, but it is registry-wide, carries no session, and says nothing about skills; a client would repull every session's commands and still never refresh a skill catalog.

## Consequences

The wire gains one frame and the Client one typed event, and every catalog a preset decides now has one place to subscribe: a future per-session surface derived from the composition invalidates on the same signal instead of inventing another. The cost is that the frame is a second reader of a logged fact — the host stream must keep deriving it from `agent-preset/selected`, so a future switch path that recomposes without logging would go unannounced. `ui-command` stays soft (the open menu never blanks) while `ui-skill` drops its entry outright, because a skill catalog has no partial-serve mode; a menu opened inside the refetch window shows no skills for that instant rather than the wrong ones.

## Testing

`api-proxy-agent-preset.spec.ts` asserts the committed switch frames once with the session and its new preset; `wire-events.spec.ts` asserts the frame-to-event bridge; the `ui-command` and `ui-skill` specs assert that the event repulls the recomposed session and leaves every other session's cache serving. The `agent-preset-selection` web e2e seeds a project skill and, after the hero chip applies `minimal`, asserts the `/` menu drops `compact`, `plan`, and the skill while keeping the host-plane rows — the assembled-application evidence that the panel follows the composition.

That e2e also stopped reading its staged-pick assertion off the serialized session list: the seeded session records `minimal` too, so the substring answered before the switch had landed. It now addresses the live session by id.

## Related

Reaching the host on a SECOND switch is a separate defect with its own cause and fix: [the session-row identity guard](2026-08-10-session-row-identity-covers-the-preset.md). Until it landed, the e2e below could only exercise the first switch — the invalidation edge here is direction-blind, but the switch it reacts to has to happen.
