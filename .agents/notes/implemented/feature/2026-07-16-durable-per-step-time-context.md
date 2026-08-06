# Agent Note: Durable per-step time context

Status: implemented

English | [中文](2026-07-16-durable-per-step-time-context.zh.md)

## Problem

A request-only clock can tell the model the current time, but replacing that value in the system prompt removes the evidence behind earlier time-sensitive reasoning. Multi-step turns need requests to retain the readings that shaped preceding steps. The request must remain reconstructable after restart, and automatic compaction must account for the same timing context the model receives.

A process-local refresh cache makes displayed time depend on state that cannot survive resume or be reconstructed from the durable session. Durable interval scheduling can reduce append frequency without introducing that hidden state.

Local calendar work also needs to distinguish two authorities: the immutable zone captured by the Session and the zone attached to each browser-originated request. Process state or a mutable connection default cannot represent travel, concurrent tabs, or old headerless Sessions without silently reinterpreting a request.

## Decision

`@deepseek-ai/dsh-time-context` is an opt-in function plugin in `packages/context/time-context/`. The `context/` group holds bounded request-context enrichments that define neither a tool nor a service. Default compositions leave its disclosure and token cost disabled; the explicit Schedule Web overlay mounts it because local `at` interpretation consumes its authority.

When a reading is due, a prepended `system-prompt/assemble` listener opens a narrow authority envelope in the ordinary next-step inbox. It captures the already-claimed messages, and each user steering insertion admitted during asynchronous assembly synchronously stages a superseding authority. AgentLoop includes non-authority messages inside the closed envelope in the downstream `agent/pre-step` proposal, so ordinary guards, edits, discards, and filtering see the late input.

After downstream pre-step transformations settle, time-context derives one final authority from the returned messages. An entering step appends those messages and only the final authority after `step/start`, before request derivation. An empty decision consumes the envelope without opening a request. A rejection, throw, or cancellation removes the envelope before the failed turn closes and may settle an already-sampled final authority inside that turn; append rejection drops it instead of leaking it. Disposal removes pending authorities and prevents an in-flight listener from contributing after disposal.

Each reading's strict source is `{ kind: 'plugin', plugin: 'time-context', authority }`. The authority identifies the proposed turn and step, reports the immutable `SessionHeader.timeZone` as `resolved` or `unavailable`, and folds the final request chain's browser provenance into `resolved`, sorted `mixed`, or `missing`. The rendered clock uses the Session zone when available. A headerless Session uses the configured fallback, or the Node process zone resolved once at plugin load when config is omitted, while its machine Session authority remains `unavailable`. Every explicit or Session-owned IANA zone is validated through `Intl.DateTimeFormat`.

The optional `refreshIntervalMs` config is manually validated at plugin load as a non-negative safe integer. Omission or `0` injects on every eligible preparation attempt. A positive value scans the raw session events for the most recent `user/message` with this plugin's source and injects when none exists, wall time moved backward, or the event is at least the configured age. The raw event timestamp governs even after compaction shadows the message, so scheduling persists across turns and process resume without a timer or process-local cache.

### Text and elapsed baselines

An injected first-step reading is:

```text
Time sampled while preparing turn <turn>, step 1: <timestamp>
Session time zone: <iana-zone-or-unavailable>.
Client time zone for this request: <iana-zone-or-mixed-set-or-missing>.
Elapsed since the preceding model-visible message: <duration-or-unavailable>.
```

The baseline is the latest durable preceding user, assistant, or tool-result message. The prompt entering the same proposed step has not been appended yet; the first request in a new Session therefore reports `unavailable`. Existing durable history supplies the baseline on later turns.

An injected later-step reading is:

```text
Time sampled while preparing turn <turn>, step <step>: <timestamp>
Session time zone: <iana-zone-or-unavailable>.
Client time zone for this request: <iana-zone-or-mixed-set-or-missing>.
Elapsed since the preceding step context: <duration-or-unavailable>.
```

Their baseline is the durable event timestamp of the preceding time-context message in the same turn. If interval suppression leaves no earlier same-turn reading, the duration is `unavailable`. Duration formatting uses compact whole-second units and clamps backward wall-clock movement to zero. The explicit turn and step make every retained reading attributable to its historical preparation attempt after later turns append more context.

### Durability and request reconstruction

Each reading remains a normal surface node until compaction shadows it; positive interval scheduling never removes existing readings. A later request therefore sees the cumulative unshadowed readings that affected earlier preparation and steps, rather than a system-prompt value rewritten in place. The strict source makes the same Session and request-zone authority available to typed consumers such as Schedule without parsing model-facing text.

The plugin uses system-prompt assembly only as the bounded preparation window; it does not add a system-prompt section. `request/header` contains no time-context text, and request reconstruction obtains the complete durable surface prefix at each `step/start`. Readings and requests need not map one-to-one because interval suppression can enter a request without appending a reading, while a failed no-step preparation may retain its already-sampled authority without transmitting a request.

## Testing

Unit and real-loop tests pin formatting, Session/fallback display zones, resolved/mixed/missing client authority, both elapsed baselines, interval omission and zero, threshold boundaries, cross-turn and per-session scheduling, backward-clock behavior, invalid config, resumed raw-event lookup after compaction, late steering, edit and discard, empty suppression, append rejection, default and keep-inbox cancellation, in-flight disposal, source decoding, cumulative multi-step visibility, and absence from request headers. A keyless subprocess e2e boots the real Loader with the Headless composition, drives two ordered one-shot turns, and verifies the persisted plugin-attributed messages externally; the Schedule Web scenario verifies the authority through the assembled browser path.

## Alternatives considered

- **Keep the dynamic system-prompt section and process-local refresh cache** — rejected because replacement erases earlier readings, cache state is not replayable, and a frozen request envelope would make the value stale for an entire loop instance.
- **Replace the preceding context surface node** — rejected because replacement preserves the old node's position or shadows intervening conversation; neither represents when the new reading became visible.
- **Inject from a background timer** — rejected because idle time has no pending request to consume the value, and timer-driven injection would create durable turns solely to report time passing.
- **Expose time only through a tool** — rejected because ordinary temporal reasoning would require an avoidable tool round trip and would not guarantee a reading before every step.
- **Use `agent/session-prefix`** — rejected because one loop-instance prefix cannot represent distinct step timestamps and does not accumulate historically attributable readings.
- **Mutate assembled requests or register independent prompt variables** — rejected because request-local insertion bypasses the durable surface and separate providers can sample different instants. One attributed context message records the timestamp and elapsed baseline atomically.
- **Use the process zone or most recent browser as request authority** — rejected because deployment state cannot infer a remote user's zone, while a mutable connection default lets travel or concurrent tabs reinterpret another request. The process or configured zone remains only a display fallback for headerless Sessions.
- **Mount the plugin in default compositions or place it in `core/`** — rejected because disclosure, freshness, and history cost are deployment choices for an optional context leaf. A feature-specific overlay may opt in when it has a current authority consumer.

## Consequences

- Omission or `0` records every eligible preparation attempt; a positive interval reduces append frequency and history growth while preserving durable scheduling across resume.
- Timing context remains append-only until compaction shadows older surface nodes, including an already-sampled preparation reading settled inside a turn that opens no step.
- First-step duration measures from the previous durable model-visible event, while later-step duration measures model and tool processing since the preceding step context.
- Session authority is immutable and request authority is message-bound, so travel or concurrent tabs expose disagreement instead of changing shared state.
- A headerless Session renders through the configured or deployment-process fallback but remains machine-readable as `unavailable`; elapsed time still uses durable harness append boundaries rather than client-origin timestamps.
