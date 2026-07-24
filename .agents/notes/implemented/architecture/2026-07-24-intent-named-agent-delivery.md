# Agent Note: Name public agent delivery by intent

Status: implemented

English | [中文](2026-07-24-intent-named-agent-delivery.zh.md)

## Problem

A configurable `send(content, { target?, wakeup?, ... })` makes every caller learn the loop's routing matrix, its defaults, and the interaction between active-turn targeting and model activation. Optional routing fields also let advanced-looking calls silently become ordinary sends. Most callers have one semantic intent, while some adapters already possess exact routing facts and should not have to reverse-map them into a helper name.

Sharing helper implementations through an abstract `Agent` class also makes the public seam nominal in practice. Object-literal adapters and tests must inherit prototype methods even though the package promises a swappable structural handle. The shared base exists only to forward fixed arguments, while the concrete loop remains the sole production adapter.

## Decision

`Agent` is a structural interface with four intent-named delivery helpers:

- `followup()` queues an ordinary turn and wakes the driver.
- `queue()` queues an ordinary turn without waking an idle driver.
- `steer()` targets the running turn and requests another step; while idle it becomes a waking ordinary turn.
- `inject()` appends model-facing context without running the model.

`followup`, `queue`, and `steer` accept `SendOptions`; `inject` accepts `InjectOptions`, which omits attached contexts because injection has no inbox item to own them. `followup` names the waking next-turn operation used for both initial prompts and later independent prompts.

`Agent` also exposes `send(ResolvedAgentInput)` for callers that already hold the complete route. Every field is mandatory: content, source, contexts, metadata (possibly `undefined`), target, and wakeup. The discriminated union requires the empty context tuple for non-waking next-step injection. `ReactLoopAgent` implements this method once, and all four helpers resolve their defaults before delegating to it. The method accepts the delivery facts as one resolved input; acceptance can still lead to later dequeue, discard, or durable injection rather than eventual delivery.

The target/wakeup matrix is an explicit advanced part of the structural `Agent` interface, not the ordinary helper options and not a base-class implementation seam. With one concrete adapter, a protected subclass seam would be hypothetical; callers and tests use the same public interface.

## Alternatives considered

**Keep the resolved primitive private.** This minimizes the public method count, but forces adapters that already hold exact target/wakeup facts to reverse-map them into helper calls and removes the reusable type for that resolved state.

**Use configurable `send(content, options)` as the primitive.** Optional routing fields would let advanced-looking calls silently become ordinary sends. One mandatory discriminated input keeps the resolved route explicit and rejects attached contexts on injection.

**Name the primitive `acceptInput`, `sendInternal`, or `addMessageAdvanced`.** `acceptInput` describes the synchronous acceptance boundary but not the caller's delivery action. A public method must not describe itself as internal, and `addMessageAdvanced` is inaccurate because the input may later be discarded.

**Use `send(content, options)` as the waking-turn helper.** This reserves the shortest delivery name for one preset and forces callers with complete target/wakeup facts through a less direct primitive name. `followup` distinguishes the next-turn/wakeup intent while leaving `send` for the resolved operation.

**Bind source first through a public sender object.** A source-bound adapter can make attribution explicit for repeated producers, but it adds another public object and does not simplify one-off human input. The existing source default remains, with the standing requirement that non-human producers label their content.

## Verification

Focused agent-loop coverage exercises direct fully resolved acceptance, waking sends, quiet queues, active and idle steering, injection, source/context snapshots, cancellation, and inbox lifecycle correlation through the public methods. Type-level coverage uses structural `Agent` fakes, requires every `ResolvedAgentInput` field, requires empty contexts on its injection variant, and keeps routing fields out of `SendOptions`. The keyless Cordis inspection snapshot pins the structural interface without an abstract-class implementation.

## Consequences

Ordinary callers choose one verb instead of encoding two routing axes; advanced callers may submit the exact discriminated route. The concrete loop retains one acceptance path and one ownership boundary, while the structural interface preserves simple adapters and fakes. Adding a common delivery intent still requires an explicit public helper and mapping rather than another optional matrix combination.

The advanced method adds interface surface and requires structural fakes to implement it. In return, resolved routing has one typed representation, while helper defaults and mappings stay beside the only implementation that owns them.

## Related

- [unified delivery and coalesced user messages](2026-07-22-unified-send-and-coalesced-user-messages.md) owns the shared acceptance mechanism, inbox lifecycle, and durable event convergence this decision narrows at the public seam.
