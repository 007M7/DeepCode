# Agent Note: Name public agent delivery by intent

Status: implemented

English | [中文](2026-07-24-intent-named-agent-delivery.zh.md)

## Problem

A public `send(content, { target, wakeup, ... })` makes every caller learn the loop's routing matrix, its defaults, and the interaction between active-turn targeting and model activation. Optional routing fields also let advanced-looking calls silently become ordinary sends. The mechanism is useful inside the concrete driver, but exposing it gives plugins implementation knowledge without leverage.

Sharing helper implementations through an abstract `Agent` class also makes the public seam nominal in practice. Object-literal adapters and tests must inherit prototype methods even though the package promises a swappable structural handle. The shared base exists only to forward fixed arguments, while the concrete loop remains the sole production adapter.

## Decision

`Agent` is a structural interface with four intent-named delivery methods:

- `send()` queues an ordinary turn and wakes the driver.
- `queue()` queues an ordinary turn without waking an idle driver.
- `steer()` targets the running turn and requests another step; while idle it becomes a waking ordinary turn.
- `inject()` appends model-facing context without running the model.

`send`, `queue`, and `steer` accept `SendOptions`; `inject` accepts `InjectOptions`, which omits attached contexts because injection has no inbox item to own them. `followup` is absent: ordinary `send` already names the established common operation, and “follow-up” is false for a session's first message.

`ReactLoopAgent` resolves each public call into one module-private `ResolvedAgentInput` and passes it to native-private `#acceptInput`. Every internal field is mandatory: content, source, contexts, metadata (possibly `undefined`), target, and wakeup. Injection resolves contexts to the empty tuple. The private name says what the synchronous boundary guarantees: acceptance can still lead to later dequeue, discard, or durable injection rather than eventual delivery.

The target/wakeup matrix remains an implementation mechanism in `dsh-agent-loop`. It is not exported, protected, or represented by a base class. With one concrete adapter, a subclass delivery seam would be hypothetical; callers and tests use the same public `Agent` interface.

## Alternatives considered

**Keep a public configurable primitive.** Mandatory routing arguments remove defaulting mistakes but still require every caller to learn the matrix and allow invalid intent combinations such as attached contexts on injection. The concrete loop needs that flexibility; ordinary plugins do not.

**Rename the primitive to `sendInternal` or `addMessageAdvanced`.** Visibility belongs in the type and runtime boundary, not a warning in a public name. `addMessageAdvanced` is also inaccurate because acceptance may wake, queue, steer, inject, or later discard work.

**Keep `followup` as the waking-turn helper.** Existing production callers use `send`, while `followup` has no TypeScript caller and does not describe the first ordinary message. Reusing `send` preserves the familiar intent without retaining an alias.

**Bind source first through a public sender object.** A source-bound adapter can make attribution explicit for repeated producers, but it adds another public object and does not simplify one-off human input. The existing source default remains, with the standing requirement that non-human producers label their content.

## Verification

Focused agent-loop coverage exercises waking sends, quiet queues, active and idle steering, injection, source/context snapshots, cancellation, and inbox lifecycle correlation through the public methods. Type-level coverage uses structural `Agent` fakes and rejects routing fields on `SendOptions` and contexts on `InjectOptions`. The keyless Cordis inspection snapshot pins the model-facing interface without a configurable delivery primitive or abstract-class implementation.

## Consequences

Callers choose one verb instead of encoding two routing axes. The concrete loop retains one acceptance path and one ownership boundary, while the structural interface restores simple adapters and fakes. Adding a delivery intent now requires an explicit public name and mapping rather than another matrix combination.

Four short public methods duplicate a small amount of argument resolution inside the concrete adapter. That duplication is deliberate locality: defaults and routing stay beside the only implementation that owns them, and no generator support is needed merely to expose a class-shaped `Agent`.

## Related

- [unified delivery and coalesced user messages](2026-07-22-unified-send-and-coalesced-user-messages.md) owns the shared acceptance mechanism, inbox lifecycle, and durable event convergence this decision narrows at the public seam.
