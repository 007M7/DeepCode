# RFC: Keep one public stop primitive

Status: proposed

## Problem

The public `Agent` handle exposes three ways to reason about stopping work: `abort(reason?)`, `cancel(reason?)`, and `whenIdle()`. `abort()` kills only the in-flight step and leaves queued work alone; `cancel()` clears queued and steering work, aborts the running step, and handles the pre-step race; `whenIdle()` exposes the loop's private quiescence waiter to any consumer. In production, ACP uses `cancel()` for `session/cancel`, while lifecycle owners tear down agents through `AgentHandle.dispose()`. No production caller needs bare `abort()` or `whenIdle()`.

The `abort()`/`cancel()` distinction is real — `abort()` preserves queued prompts and steering while `cancel()` drops them — but no shipping code calls the public `abort()` verb. The loop's own stop paths (`cancel()` and disposal) abort the current `AbortController` directly rather than routing through `Agent.abort()`. Most tests that call `abort()` interrupt an empty queue and can switch to `cancel(reason)`; the one steering re-delivery test that deliberately depends on queue preservation should drive the in-flight `AbortController` directly, because `cancel()` would drop the queued steering it is trying to prove survives a step abort. The no-argument `abort()` default reason (`'aborted'`) is also deleted with the verb rather than preserved by accident; `cancel()` keeps its own `'cancelled'` default.

The extra surface area makes the loop carry public semantics that are mostly teardown internals. `whenIdle()` needs waiter state, special disposed-agent behavior, and a loop-exit promise so it resolves after quiescence rather than merely after a status flip. `abort()` has to be documented as distinct from queue-aware cancellation even though a UI cancellation almost always wants the broader operation.

## Proposal

Keep `cancel()` as the only public stop primitive on `Agent`. Lifecycle owners use `AgentHandle.dispose()` to stop and unregister an agent; non-owners use `cancel()` to abandon current and queued work. The implementation can keep private abort controllers and quiescence promises, but they are not part of the plugin-facing `Agent` contract.

Delete public `abort()` and `whenIdle()`, the tests that exercise them as standalone API, and the docs that describe step-only abort as an embedding feature. Empty-queue abort tests migrate to `cancel(reason)` where they still prove cancellation behavior; tests whose subject is the loop's internal `AbortController` behavior drive that controller directly; tests that only pin the removed no-arg `abort()` default go away with the method. The disposer remains async and still waits for the loop to stop; that guarantee moves entirely onto `AgentHandle.dispose()`.

## Acceptance criteria

- `Agent` exposes no public `abort()` or `whenIdle()`; `steer()` remains part of the message surface.
- ACP cancellation continues to call `cancel()`.
- Agent teardown continues to await quiescence through handle disposal.
- Tests cover cancellation and disposal as the two supported stop paths.

## What we give up

A future plugin cannot abort only the current model/tool step while preserving queued prompts through the public interface. If that use case becomes real, it should return with a named consumer and a narrower contract. Today it is latent generality that keeps private loop mechanics public.

## Related

This RFC only removes the stop/quiescence methods. Mid-turn steering remains an intentional message path; the resulting public surface is `send()`, `steer()`, `inject()`, `cancel()`, status, options, session, and identity.
