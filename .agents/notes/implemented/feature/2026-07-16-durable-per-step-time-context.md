# Agent Note: Durable per-step time context

Status: implemented

English | [中文](2026-07-16-durable-per-step-time-context.zh.md)

## Problem

A request-only clock can tell the model the current time, but replacing that value in the system prompt removes the evidence behind earlier time-sensitive reasoning. Multi-step turns need requests to retain the readings that shaped preceding steps. The request must remain reconstructable after restart, and automatic compaction must account for the same timing context the model receives.

A process-local refresh cache makes displayed time depend on state that cannot survive resume or be reconstructed from the durable session. Durable interval scheduling can reduce append frequency without introducing that hidden state.

Local calendar work also needs to distinguish two owned facts: the immutable zone captured by the Session and the zone attached to each browser-originated request. Process state or a mutable connection default cannot represent travel, concurrent tabs, or old headerless Sessions without silently reinterpreting a request.

## Decision

`@deepseek-ai/dsh-time-context` is an opt-in function plugin in `packages/context/time-context/`. The `context/` group holds bounded request-context enrichments that define neither a tool nor a service. Default compositions leave its disclosure and token cost disabled; the explicit Schedule Web overlay mounts it because local `at` interpretation needs request-zone context.

The plugin prepends an `agent/pre-step` listener and delegates first. When the downstream decision enters a request step and a reading is due, time-context derives client zones from that decision's final messages plus user-rpc messages already entered in the open turn, then appends one reading to the decision. Steering inserted after AgentLoop claims the current batch keeps ordinary next-step ownership and receives a new reading when that step enters.

An entering step appends its returned messages followed by the time reading after `step/start`, before request derivation. A first-step decision rewritten to empty opens no request, while an empty tool continuation can still enter a later step without a new reading and reuse existing history. Rejection, failure, or cancellation before `step/start` appends nothing. Disposal prevents an in-flight listener from contributing after it wins, without adding inbox state or an AgentLoop lifecycle path.

Each reading has the exact snapshot source `{ kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: <same rendered text> }] }`; both the invariant companion and Schedule fail closed if that shape or equality drifts. The immutable `SessionHeader.timeZone` and each original user-rpc message's `clientTimeZone` remain the only machine-readable owners. Time-context renders those facts for the model, while Schedule derives directly from the same header and current-turn sources instead of consuming a copy. The rendered clock uses the Session zone when available. A headerless Session uses the configured fallback, or the Node process zone resolved once at plugin load when config is omitted, while still reporting the Session zone as `unavailable`. Every explicit or Session-owned IANA zone is validated through `Intl.DateTimeFormat`.

The optional `refreshIntervalMs` config is manually validated at plugin load as a non-negative safe integer. Omission or `0` injects on every entered request step. A positive value scans the raw session events for the most recent `user/message` with this plugin's source and injects when none exists, wall time moved backward, or the event is at least the configured age. The raw event timestamp governs even after compaction shadows the message, so scheduling persists across turns and process resume without a timer or process-local cache.

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

Each reading remains a normal surface node until compaction shadows it; positive interval scheduling never removes existing readings. A later request therefore sees the cumulative unshadowed readings that affected earlier preparation and steps, rather than a system-prompt value rewritten in place. The simple source identifies the reading without duplicating the Session or request-zone facts that Schedule can derive from their original durable owners.

The plugin does not add a system-prompt section. `request/header` contains no time-context text, and request reconstruction obtains the complete durable surface prefix at each `step/start`. Readings and requests need not map one-to-one because interval suppression can enter a request without appending a reading, while a failure after step entry may retain a reading without transmitting a request. A failure before step entry retains none.

## Testing

Unit and real-loop tests pin formatting, Session/fallback display zones, unique/mixed/missing client-zone derivation, both elapsed baselines, interval omission and zero, threshold boundaries, cross-turn and per-session scheduling, backward-clock behavior, invalid config, resumed raw-event lookup after compaction, post-claim steering ownership, empty suppression, cancellation, in-flight disposal, simple source validation, cumulative multi-step visibility, and absence from request headers. A keyless subprocess e2e boots the real Loader with the Headless composition, drives two ordered one-shot turns, and verifies the persisted plugin-attributed messages externally; the Schedule Web scenario verifies the same source facts through the assembled browser path.

## Alternatives considered

- **Keep the dynamic system-prompt section and process-local refresh cache** — rejected because replacement erases earlier readings, cache state is not replayable, and a frozen request envelope would make the value stale for an entire loop instance.
- **Replace the preceding context surface node** — rejected because replacement preserves the old node's position or shadows intervening conversation; neither represents when the new reading became visible.
- **Inject from a background timer** — rejected because idle time has no pending request to consume the value, and timer-driven injection would create durable turns solely to report time passing.
- **Expose time only through a tool** — rejected because ordinary temporal reasoning would require an avoidable tool round trip and would not guarantee a reading before every step.
- **Use `agent/session-prefix`** — rejected because one loop-instance prefix cannot represent distinct step timestamps and does not accumulate historically attributable readings.
- **Mutate assembled requests or register independent prompt variables** — rejected because request-local insertion bypasses the durable surface and separate providers can sample different instants. One attributed context message records the timestamp and elapsed baseline atomically.
- **Copy request zones into a durable authority and absorb post-claim steering into the current step** — rejected because the immutable Session header and entered user-rpc sources already own those facts, while no current production assembly boundary requires inbox reentry. Copying them would add validation and AgentLoop lifecycle solely for a second representation; post-claim steering already receives fresh context in its ordinary next step.
- **Use the process zone or most recent browser as request state** — rejected because deployment state cannot infer a remote user's zone, while a mutable connection default lets travel or concurrent tabs reinterpret another request. The process or configured zone remains only a display fallback for headerless Sessions.
- **Mount the plugin in default compositions or place it in `core/`** — rejected because disclosure, freshness, and history cost are deployment choices for an optional context leaf. A feature-specific overlay may opt in when it has a current consumer.

## Consequences

- Omission or `0` records every entered request step; a positive interval reduces append frequency and history growth while preserving durable scheduling across resume.
- Timing context remains append-only until compaction shadows older surface nodes; a turn that opens no step records no reading.
- First-step duration measures from the previous durable model-visible event, while later-step duration measures model and tool processing since the preceding step context.
- The Session zone is immutable and each browser zone is message-bound, so travel or concurrent tabs expose disagreement instead of changing shared state.
- A headerless Session renders through the configured or deployment-process fallback but remains reported as `unavailable`; elapsed time still uses durable harness append boundaries rather than client-origin timestamps.
