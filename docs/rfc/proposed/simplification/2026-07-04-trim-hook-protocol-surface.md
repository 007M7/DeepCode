# RFC: Trim unused hook protocol and bridge surface

Status: proposed

## Problem

The #138 hook stack added a useful bridge layer, but the current public protocol still exposes a few fields and knobs that no shipped writer or reader uses. They are small individually; together they widen the durable hook log, the shared hook-protocol API, and both bridge configs.

`HookDialect` includes `'native'`, but real `hook/invoked` writers are the Claude and Codex bridges only. The worked native-plugin test explicitly proves the opposite: a native plugin uses typed Cordis decisions and emits no `hook/*` session events. Grepping `dialect: 'native'` finds a hook-protocol unit test, docs, and type text, not production code.

`hook/result.durationMs` is durable timing telemetry with no production reader. Both bridges write it; the ACP snapshot normalizer immediately scrubs it to `0` because wall-clock hook runtime is replay noise ([examples/acp-agent/tests/snapshot-normalize.ts](../../../../examples/acp-agent/tests/snapshot-normalize.ts)). The only remaining consumers are tests and generated goldens that exist because the field exists. Persisting a value that replay must erase is a smell: it is neither product behavior nor useful audit state.

`MergedHookOutcome.systemMessages` is also unused. The codec should still parse `HookOutput.systemMessage` because the external protocols can emit it and both bridges warn when it appears, but the merged aggregate is never read; `rg "systemMessages|\\.systemMessages"` finds the merge helper, README prose, and merge tests only. The bridge already handles warnings per raw output before merge.

Finally, both bridge configs carry optional process-level defaults that shipped configs do not set. `defaultTimeoutMs` duplicates the reference default (`600_000`) even though each command hook already has its own `timeout`; tests mostly cover schema-bypass fallback. `dsh-hooks-codex` also exposes `Config.model`, but the ACP configs load the Codex bridge with only `configPath`, and every hook payload already has an `Agent` whose `options.model` is the actual model for that run.

## Proposal

Remove the unused protocol and config surface while keeping the live external-hook behavior:

- Change `HookDialect` to `'claude' | 'codex'` until a real native `hook/*` producer exists. Native plugins keep using the typed interception seams directly.
- Remove `durationMs` from the `hook/result` session event, `HookResultRecord`, `RunHookResult`, bridge append calls, docs, generated catalog, snapshots, and the snapshot normalizer's special-case scrub. Remove the injected `now` clock from `runHook()` if it becomes unnecessary after the field disappears.
- Remove `MergedHookOutcome.systemMessages` and its tests/docs. Keep `HookOutput.systemMessage` parsing and the bridge warnings.
- Remove `defaultTimeoutMs` from both bridge configs. Keep per-command `timeoutSec`; when absent, `runHook()` uses a single shared protocol constant for the reference default.
- Remove `dsh-hooks-codex` `Config.model`; stamp Codex payloads from `agent.options.model ?? ''` at the point that has an agent, with `''` only for no-agent fallback paths.

## What stays

This RFC does not remove `hook/invoked` / `hook/result` themselves. They are live provenance: bridges append them around actual hook execution and ACP snapshots persist them. It also does not remove parsing/warning for `updatedInput`, `systemMessage`, `continue:false`, or `suppressOutput`; those are deliberate faithful-but-degraded external-protocol fields documented by [the hook bridge RFC](../../implemented/feature/2026-06-30-hook-bridges.md).

This RFC does not collapse the shared `dsh-hook-protocol` package into the bridges or build a single parameterized bridge engine. [The protocol-library RFC](../../implemented/feature/2026-06-30-hook-protocol-lib.md) explicitly keeps only the identical wire primitives shared and leaves per-dialect payload/config mapping in each bridge.

## Acceptance criteria

- `rg "HookDialect.*native|dialect: 'native'|claude.*/.*codex.*/.*native|claude.*codex.*native" packages/hooks docs/core-data-structures/session.md docs/cordis-catalog/events-and-services.md --glob '!docs/rfc/**'` finds no `HookDialect` branch, test writer, or `hook/*` docs claiming a native durable writer.
- `rg "durationMs" packages/hooks examples/acp-agent/tests docs/core-data-structures/session.md docs/cordis-catalog/events-and-services.md --glob '!docs/rfc/**'` finds no hook-result field, snapshot scrub, or generated-golden requirement outside unrelated timing concepts.
- `rg "systemMessages|\\.systemMessages" packages/hooks docs --glob '!docs/rfc/**'` finds no merged aggregate surface, while `systemMessage` parsing and bridge warnings remain covered.
- `rg "defaultTimeoutMs|Config\\.model|model\\?: string" packages/hooks docs --glob '!docs/rfc/**'` finds no bridge config knob for the removed defaults, while per-hook timeout support and Codex payload model stamping still work.
- Hook bridge unit tests and ACP hook snapshots still prove prompt-submit, pre-tool, post-tool, and stop behavior for both dialects.
- `pnpm run test:coverage`, `pnpm run test:snapshot`, `pnpm run doc-sync`, and `pnpm run hygiene` pass after implementation.

## Risks

- Durable hook timing can be useful diagnostics. If a product UI or trace viewer wants it, add live diagnostics or an intentionally durable telemetry event then; do not keep replay-noisy timing in the base hook-result record without a reader.
- A future native hook provenance logger might want `dialect: 'native'`. Add it with that logger. Until then, documenting native hooks as `hook/*` writers blurs the important design point that native plugins do not need the shell-hook log.
- A deployment could want a process-level Codex model override for hook payloads. The agent already knows its actual model, which is less surprising than a bridge-level default that can drift from the run being observed.
