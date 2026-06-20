# RFC: Keep one public stop primitive

Status: proposed

## Problem

The public `Agent` handle exposes three ways to reason about stopping work: `abort(reason?)`, `cancel(reason?)`, and `whenIdle()`. `abort()` kills only the in-flight step and leaves queued work alone; `cancel()` clears queued and steering work, aborts the running step, and handles the pre-step race; `whenIdle()` exposes the loop's private quiescence waiter to any consumer. In production, ACP uses `cancel()` for `session/cancel`, while lifecycle owners tear down agents through `AgentHandle.dispose()`. No production caller needs bare `abort()` or `whenIdle()`.

The extra surface area makes the loop carry public semantics that are mostly teardown internals. `whenIdle()` needs waiter state, special disposed-agent behavior, and a loop-exit promise so it resolves after quiescence rather than merely after a status flip. `abort()` has to be documented as distinct from queue-aware cancellation even though a UI cancellation almost always wants the broader operation.

## Proposal

Keep `cancel()` as the only public stop primitive on `Agent`. Lifecycle owners use `AgentHandle.dispose()` to stop and unregister an agent; non-owners use `cancel()` to abandon current and queued work. The implementation can keep private abort controllers and quiescence promises, but they are not part of the plugin-facing `Agent` contract.

Delete public `abort()` and `whenIdle()`, the tests that exercise them as standalone API, and the docs that describe step-only abort as an embedding feature. The disposer remains async and still waits for the loop to stop; that guarantee moves entirely onto `AgentHandle.dispose()`.

## Acceptance criteria

- `Agent` exposes no public `abort()` or `whenIdle()`; if [retiring mid-turn steering](2026-06-20-retire-mid-turn-steering.md) has not landed, `steer()` remains part of the message surface.
- ACP cancellation continues to call `cancel()`.
- Agent teardown continues to await quiescence through handle disposal.
- Tests cover cancellation and disposal as the two supported stop paths.

## What we give up

A future plugin cannot abort only the current model/tool step while preserving queued prompts through the public interface. If that use case becomes real, it should return with a named consumer and a narrower contract. Today it is latent generality that keeps private loop mechanics public.

## Related

This RFC only removes the stop/quiescence methods. If it lands before [retiring mid-turn steering](2026-06-20-retire-mid-turn-steering.md), `steer()` remains part of the `Agent` message surface; if the steering RFC lands first, the resulting surface is `send()`, `inject()`, `cancel()`, status, options, session, and identity.
