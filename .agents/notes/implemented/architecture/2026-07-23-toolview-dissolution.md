# Agent Note: Toolview dissolution — tool rows are per-view keyed slots

Status: implemented

English | [中文](2026-07-23-toolview-dissolution.zh.md)

> Scope: why the standalone tool ring (ToolViewRegistry/ctx.toolviews/outlet) was retired and what replaced it. The [web client architecture note](2026-07-19-gui-web-client-architecture.md) carries the shipped-state narrative this decision produced; the [slot system standard](2026-07-22-slot-type-chain-implementation.md) owns the registration model everything now runs on.

## Problem

After the view ring dissolved into the slot system, the client kept exactly one parallel registration model: the tool ring — a named registry (`ctx.toolviews`) with its own register grammar, its own resolve semantics (scoped-beats-global predicate dispatch), its own subscribe/version pair, its own inject cache, and its own render outlet with a private error boundary. Every one of those was a second implementation of something the slot machinery already owned, and every future capability (a store seat for row drafts, i18n injection, cross-bundle identity) would have had to be built twice or drift. The ring's one honest justification was that tool names are a runtime-open set while `SlotMap` is a closed declaration table — a registry keyed by arbitrary strings seemed structurally necessary.

## Decision

The tool ring is gone as independent infrastructure: a tool row is a **keyed child slot each view declares for itself**, and the client has exactly one registration model. The justification above was hollow — a keyed slot's *key space* is already runtime-open (SlotMap declares slots, never keys; the ask-user composer's `key: 'question'` was the precedent), so the open tool-name set fits `entryKey` dispatch natively.

Shipped shape (current-state narrative also in the [architecture note](2026-07-19-gui-web-client-architecture.md)): the chat entry's `children` table declares `'conversation.chat.toolview'` (keyed/session); the render site dispatches per row via `entryKey: toolName` with `GenericToolCard` as the call-site `fallback` (the default card is domain property; the fallback option is ordinary renderSlot grammar). The owner payload is the uniform `ToolRowOwnerProps` (`callId`/`toolName`/`block`/`openDetails` — details being a session-level facility, not chat-private), and `ToolRowProps` pre-composes it with the session standard kit for registrant components. A registrant is a plain plugin using `ctx.slots.inject('conversation.chat.toolview', () => ctx.slots.register({ name: 'conversation.chat.toolview', key: '<tool>', inject? }, Row))`; the declaration itself governs activation and replacement, without a false `ConversationService` edge ([decision](2026-08-05-slot-declaration-injection.md)). The bash sample is the third-party-posture exemplar and paints the same ToolRow chrome as Think (`Bash · {description}`). Trajectory/waterfall toolview slots share this exact shape (names fixed by the slot-naming discipline `<domain>.<entry>.<hole>`, one shared owner type) and land with their own row render sites — RendersCheck rejects a declaration nobody renders, so the type system, not convention, blocks early empty declarations.

Registry-era responsibilities all have successor homes: inject caching and row error isolation ride the framework renderer (entry×scope cache, per-entry `SlotErrorBoundary`); subscribe/getVersion ride the slot core's per-key version machinery; the future "store seat" is the ordinary store seat keyed slots already have (interaction-draft durability is its first named consumer); miss fallback is the call-site `fallback` option.

## Accepted semantic changes

Four behavioral deltas were accepted deliberately, not overlooked. Cross-view appearance is per-view registration — a row must adapt to each view's layout anyway, so one registration per view is the correct coupling, and reuse is the same component in two register calls. Same-key double registration is a loud throw where the registry let later-wins silently override — a discipline correction, not a loss. Session-dimension dispatch, when a row needs it, belongs inside the component (the standard kit already carries `useSessions`), not in registry predicates — there is no shipped session-variant exemplar today. Registry-level shape override by third parties (a scoped registration shadowing a global one) has no equivalent; a real future need routes through key-naming conventions or a small in-component resolver, never a revived parallel registry.

## Alternatives considered

**Keep the standalone registry (the original shape).** Rejected: each of its multi-dimensional dispatch axes has a more correct home — the view dimension belongs to each view's own declared child slot (declaring is claiming, so specialization ownership lands right), and the session dimension belongs inside the component, which already holds the standard kit. What remained after both moves was a second copy of slot machinery with no distinguishing capability.

**Promote `renderToolView` into the standard kit and move the registry into the runtime package.** Rejected: "tool row" is a conversation-domain concept; hoisting it into runtime would leak a domain vocabulary into the framework layer and still leave two registration models.

**Derive slot declarations from subscription refCounts** (declare the slot implicitly when the first registrant subscribes). Rejected for implicit coupling and debounce complexity; noted as a possible revisit only if a genuinely multi-viewer surface appears.

**A thin `registerToolView` facade over slots.register.** Deferred, not rejected: after dissolution the facade would carry only compile-time sugar (slot-name literal narrowing, tool→key vocabulary, props pre-composition) with zero runtime. Per "enforce at the operation boundary" (a facade is not an enforcement point) and "don't split preemptively" (today's registrant population is one bash sample), it stays unbuilt; the type sugar ships as the exported `ToolRowProps` alias. Regret clause: if registrants grow to three-to-five or a bulk-registration pattern appears, the facade is ten lines added without disturbing direct registration.

## Consequences

The client has one registration model; auditing who renders tool rows = reading register calls, the same audit as every other slot. Registrants get the framework's error isolation, inject caching, and store seat for free — no capability ships twice. The costs are the accepted semantic changes above (chiefly: per-view registration for cross-view rows, and no third-party registry-level override). Independent registrants name the typed slot in `ctx.slots.inject`, so the dependency is explicit and follows declaration replacement without a service-order convention.
