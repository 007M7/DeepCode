# Agent Note: Opt-in reasoning chunk browser stress lane

Status: implemented

English | [中文](2026-08-03-opt-in-reasoning-chunk-browser-stress.zh.md)

## Problem

The browser freeze caused by a long reasoning stream emerges across the fixture async stream, client session reduction, React reconciliation, and the live Think row. Small unit tests prove event semantics but do not expose renderer starvation, while putting a 100,000-chunk scenario in the required [web browser lane](2026-07-24-web-gui-browser-e2e-lane.md) would add a slow, intentionally red reproduction to every pull request. A producer paced by `requestAnimationFrame` also gives the renderer implicit backpressure: when the page stalls, production stalls with it and hides the network-arrival condition that triggers the regression.

## Decision

`pnpm run test:web:stress` is the explicit entry point for browser performance reproductions. Its dedicated `vitest.web-stress.config.ts` includes only `apps/web/stress-tests/**/*.stress.ts`; the default unit and web configurations do not collect that suffix. The command builds first because Chromium consumes emitted client artifacts, and `tsconfig.host.json` owns the stress spec because the spec boots the host scaffold.

The reasoning scenario selects the deterministic `?fixture` session and asks an opt-in fixture timing hook to emit exactly 100,000 individual `reasoning-delta` events. The producer has a nominal external cadence of 128 events every 16 milliseconds and repays elapsed-interval debt after a main-thread stall. This approximates bytes continuing to arrive outside the renderer without synchronously preloading a giant fixture queue. A terminal marker proves that the events crossed session reduction and reached the live Think row.

The browser installs a 50-millisecond heartbeat and schedules a DOM event before starting the stream. The final report includes emitted chunks, maximum heartbeat delay, scheduled-interaction delay, and heartbeat samples. Both delay measurements have a 250-millisecond budget. While the regression remains, the opt-in command prints the measurements and exits nonzero; it becomes the acceptance check for the renderer fix without making an already-known performance failure a default CI gate. `DSH_WEB_STRESS_HEADFUL=1 pnpm run test:web:stress` exposes the same scenario in a visible browser.

The default fixture unit suite exercises the timing hook with three chunks and fake timers. That small contract pins input validation, interval pacing, concurrency rejection, exact event count, and terminal-marker delivery without carrying the 100,000-chunk workload into `pnpm test`, `pnpm run test:gui`, or `pnpm run test:web`.

## Alternatives considered

**Required web browser scenario.** Rejected: the reproduction currently takes tens of seconds and is expected to fail its responsiveness budget, so making it required would block unrelated work before the production fix exists.

**Animation-frame pacing.** Rejected after measurement: tying production to paint kept the maximum observed delay below the budget because the producer slowed whenever rendering slowed. That tests a backpressured source rather than the reported continuous-stream workload.

**One synchronous 100,000-event enqueue.** Rejected: it would block the page in the producer itself and would load `FxInbox` with a huge array drained by `shift()`, confounding renderer cost with fixture queue mechanics.

**A live model or recorded HTTP byte stream.** Rejected for this reproduction: a live stream is nondeterministic, and HTTP-level recording adds fixture cost without improving the target assertion. The in-memory fixture omits HTTP/SSE byte framing but preserves individual asynchronous session events and the production client reduction and React rendering path where the freeze is observed.

## Consequences

Developers now have a keyless, repeatable command that reproduces the long-reasoning freeze with an exact workload and emits machine-readable responsiveness evidence. The default suites remain fast and green, but the stress lane must be invoked explicitly during diagnosis and before accepting a renderer fix. Its timing threshold is a browser responsiveness guard rather than a throughput target; hardware changes can alter total duration, while a multi-second heartbeat or interaction delay remains an unambiguous failure.
