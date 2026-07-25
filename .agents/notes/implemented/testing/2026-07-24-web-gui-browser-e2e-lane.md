# Agent Note: Keyless browser e2e lane for the web GUI

Status: implemented

English | [中文](2026-07-24-web-gui-browser-e2e-lane.zh.md)

## Problem

The web GUI ships as a real assembled chain — chromium page → client plugin bundles → HTTP unary RPC + two SSE streams → `toFetchHandler`/apiproxy → the host agent loop, tools, and JSONL persistence — and no test exercised that chain keylessly and deterministically. The [GUI testing system](../process/2026-07-20-gui-testing-system.md) covers tier 1 (wire isomorphism in node), tier 2 (object-layer state machines), and tier-3 smokes, but the keyless smoke drives `FixtureApiClient` — no host, no wire, no agent loop — while the full-chain smoke needs `DEEPSEEK_API_KEY` and a live model, so it is nondeterministic and self-skips in keyless CI. The snapshot philosophy of [docs/testing.md](../../../../docs/testing.md) — record once with a key, replay forever keyless, refresh on format churn — already covers the ACP, headless `stream-json`, and TUI transcript surfaces; the web surface was the one assembled product shape without it. The gap is exactly where the two confirmed GUI P0s hid: the wire carriage chain the fixture client short-circuits.

## Decision

`pnpm run test:web` carries a keyless, deterministic browser e2e lane under `apps/web/tests/`: recorded session-log fixtures replayed through `@deepseek-ai/dsh-llm-replay` against the real in-process web composition, asserting a normalized conversation aria golden plus in-process world state. No new package; the product deltas are two additive `dsh-llm-replay` surfaces (`paceMs`, `ReplayHandle`).

### Scaffold: `apps/web/tests/scaffold.ts`

A plain shared-fixture module (the [testing-policy sanctioned shape](../../../../docs/testing.md)), not a package: the gate-worthy logic — replay derivation, session parsing, log scrubbing, persistence — lives in the gated packages `dsh-llm-replay`, `dsh-acp-snapshot`, and `dsh-session-persistence-jsonl`; what remains is boot wiring and browser glue, and chromium-driving code cannot hold per-file 100% coverage on the browserless coverage runners.

`launchWebScaffold()` boots the real web composition from the shipped `apps/cli/cordis.yml` through the vendored Loader's include mechanism — the same tree and mechanism `AppCLIEntry` drives for `dsh web`. Divergences ride include patches over that tree, the ACP `cordis.snapshot.yml` pattern expressed in-process: temp `persistenceRoot`, `workspace-context` disabled (recorded fixtures must not embed this repo's AGENTS.md), `session-title-llm` disabled (its fire-and-forget title call would race the loop for the session's replay cursor), the webserver row pinned to port 0 with the built dist, and in keyless modes `llm-deepseek` disabled. A patch id that stops matching a row fails the boot sweep loudly instead of drifting. The boot runs `chdir`'d to the temp workspace so the api-gateway's `process.cwd()` session default, tool cwds, and fixtures agree; the `dsh web` bin's own glue (argv, profile json, AppCLIEntry) stays held by the keyless CLI smokes in `smoke-real.e2e.ts`. Setup rollback and ordinary close both dispose the Cordis tree before removing the two owned temp roots, attempt every cleanup independently, and report cleanup failures without masking the setup failure.

Keyless model displacement is the disabled adapter row plus `installLlmReplay` filling the open seam on the settled root ctx in providers-catalog mode — never catch-all: with the adapter row disabled no adapter exists, so catch-all would leave `resolveModelContext` unroutable and `compact-basic`'s post-step pressure check would warn every step instead of being provably inert (the published 128k `contextWindow` keeps it inert for small fixtures). The direct install rather than an inserted replay plugin row is deliberate: it returns the `ReplayHandle` the teardown consumption check needs. A scenario with no fixture leaves the seam empty, so a stray stream fails loud with NO_ADAPTER.

`seedSession()` seeds cold sessions through the real persistence API — a throwaway `Context` mounting `SessionStore` + `SessionPersistenceJsonl` against the host's root, `create()` + `append()`, one `utimes` backdate for deterministic sidebar order (the `semantic-checkpoint.snapshot.ts` precedent) — never raw file writes, so the seeder knows nothing of bucket hashing, filename encoding, or compression, and the host's zstd default needs no boot knob. Seeds are validated at seed time (parseable, ending in `turn/end` — an open final turn would be mutated by resume's crash repair).

### Determinism rules

The barrier stack for replay-mode browser assertions is, in order: (1) host-side `await agent.whenIdle()` under a timeout, keyed off the in-process `turn/end` — the idle flip follows the persistence flush, so one await covers turn completion and durability; (2) browser settled poll (streaming detached, final text visible). Record-mode log harvest runs after `whenIdle()` and before scaffold disposal while the live session remains available. An in-process `turn/end` listener alone is a wrong barrier (it fires before the SSE frame reaches the browser and before the fsync); file polling is banned (slow on NFS, superseded by `whenIdle`); `networkidle` is banned outright (never resolves while an SSE stream is open).

No single-shot transient-DOM assertions: every hop from replay yield to React commit can coalesce chunks, so sampling `[data-streaming]` is a race by construction. Streaming incrementality is asserted from the persisted `assistant/chunk` events (model-visible ⟺ logged makes the log the authoritative proof). `dsh-llm-replay`'s opt-in `paceMs` (default absent = burst) is a realism knob so the browser observes genuinely incremental SSE; correctness never leans on it, and abort during a pace wait cancels promptly.

Every scenario fails on any pageerror and on the client's connection-loss/gap-repair console warnings: the reconnect machine plus history resync would otherwise self-heal a dead SSE path and the suite would certify a broken wire. Scaffold `close()` calls the `ReplayHandle.assertConsumed()` teardown check (every recorded script bound, every cursor drained), converting silent underruns and shifted bindings into crisp diagnostics. No vitest retry on the lane; one chromium per file, fresh context per scenario, one host per scenario; viewport pinned; interaction selectors anchor on roles, `data-*` attributes, and visible text, while the frame and conversation-region captures use the existing CSS-module local-name anchors.

### Expected outputs

One committed golden per scenario: a normalized `ariaSnapshot()` of the conversation region (`ui.expected.md`) — uuid/cwd/workspace-basename/duration tokens normalized, captured poll-until-equal at the settled milestone — plus a few role/text anchor assertions that stay green under a semantics-preserving component rewrite while the golden churns reviewably. The aria tree is the mechanization of the client rule "assert what the user would see, never class names". World-state assertions ride root-context session events inline (which tool call produced which durable result, whether `turn/end` completed) instead of a second committed log golden: the persisted-log surface is pinned by the ACP/headless/TUI suites through the same loop and persistence, and re-pinning it here would double refresh cost against the tier discipline. `refresh` is the sole golden writer — a missing golden in replay mode fails with the healing command rather than self-bootstrapping.

The typecheck plane split is structural: the three files that boot the host spine (`scaffold`, `replay-round-trip.e2e`, and `seeded-history.e2e`) are excluded from the client-registered `apps/web` project. Those files and their shared `support.ts` are included file-by-file in `tsconfig.host.json` — one program cannot hold both sides of the cordis `Context` merges.

### Modes and fixtures

`DSH_SNAPSHOT` selects replay (default, keyless), record (with key), or refresh (keyless) as inline spec branches — the TUI shape, not a suite factory: at two scenarios the acp-snapshot factory machinery has no owner, and the genuinely shared parts are already exported (`scrubRequestHeaders`, `parseSessionLog`, `installLlmReplay`). Each spec splits into drive steps (type, send, `whenTurnSettled` — run in all modes, never waiting on model-content selectors, so record cannot hang on a live model answering differently) and assertion steps (replay/refresh only). Record = drive live through the real composer + harvest the in-memory `session.header`/`session.events` (the TUI `rawSessionLog` shape — no file decompression) + `scrubRequestHeaders` + `{{sessionId}}`/`{{cwd}}`/`{{rpcId}}` tokenization; a follow-up keyless refresh regenerates `ui.expected.md`. Both scenarios' fixtures were recorded against this assembly through this flow. A drift guard ties each spec's drive prompt to the fixture's recorded `user/message`. A fixture-inventory guard holds each scenario directory closed (exact file set, every JSONL a scrub fixed-point with no run-local `rpcId`). Web fixtures scrub headers everywhere and pin no header class, following the TUI precedent over the strict [pinned-header](2026-07-06-pin-request-header-content-in-one-scenario.md) reading — see Deferred.

### Scenarios

1. **`replay-round-trip`** — new session, prompt through the real composer, replay streams reasoning + a `bash` tool call that really executes in the temp workspace + final text (paced 15ms). Asserts settled markdown, the aria golden, and inline world state (the bash call's durable result is exactly `WEB_E2E_OK\n`, completed `turn/end`, >10 chunk events).
2. **`seeded-history`** — a recorded session seeded cold; the sidebar lists it (group row → session row, collapsed by default), opening renders tool cards and text purely from the log through the implicit cold-resume attach inside `session.history` — zero model calls in replay, so no binding constraints; record mode drives the same turn live (real `read` tool against seeded workspace files) to produce the seed.

### CI stance

The lane ships gate-exempt inside `pnpm run test:web`, exactly as that config's header records. Adding chromium to CI would reverse the "no browser infrastructure in CI" premise in the [GUI testing note](../process/2026-07-20-gui-testing-system.md) and therefore requires its own Agent Note cross-linked from there, staged as a non-required job first with measured promotion criteria (consecutive green runs, wall time, zero-retry flake budget, runner browser-cache strategy). `TODO(ci-browser)` marks the seam. Scenarios are POSIX-oriented (the lane is not in the Windows matrix).

## Prior art

Surveyed AI-chat/agent web UIs and mocking layers (LibreChat, vercel/ai-chatbot + AI SDK, lobe-chat, open-webui, OpenHands, Chainlit, continue, cline, langfuse, gradio/streamlit; Playwright HAR/route, MSW, Polly/nock, WireMock, aimock). The dominant proven architecture for apps that own their backend is an in-process fake/replay model behind the real backend seam with everything downstream real (LibreChat's `LIBRECHAT_TEST_RUN_HOOK` fake model; ai-chatbot's `MockLanguageModelV3` + `simulateReadableStream`; continue's scripted mock provider classes) — which is what `dsh-llm-replay` already is. Browser-level SSE interception cannot exercise incremental rendering (`route.fulfill` delivers the whole body at once; playwright#33564) and leaves the server SSE stack untested, so projects use it only for edge cases. Chunk pacing as a fixture parameter recurs everywhere (LibreChat 10ms default with slow profiles; ai-chatbot 500ms); real models in CI rot (open-webui's suite grew 120-second timeouts, was disabled, then deleted); sessions are seeded at the persistence layer with controlled timestamps (LibreChat inserts backdated Mongo documents; langfuse seeds its DB). No surveyed project replays a recorded agent-event log through the real backend for UI tests — the closest are provider-level recorded fixtures (aimock) and frontend-level socket history emission (OpenHands MSW) — so the session-log-as-fixture design goes one step beyond prior art along the axis this repo's model-visible ⟺ logged invariant makes natural.

## Alternatives considered

**Browser-network SSE interception (`page.route`).** Rejected: `route.fulfill` cannot stream, so incremental token rendering is unexercisable and the server-side SSE/backpressure/close path — where both confirmed P0s hid — goes untested.

**Mock HTTP provider at `DEEPSEEK_BASE_URL`.** Rejected as the lane's mechanism (kept for the one existing workspace-probe smoke): fixtures become hand-authored OpenAI SSE byte scripts, a second fixture format that drifts from the session-log format the rest of the repo records and replays; the adapter's real HTTP path is with-key e2e's job.

**Growing the `?fixture` client.** Rejected: tier separation — `FixtureApiClient` exists to test the client shell without a server; everything below the client API seam stays untested by construction.

**Placeholder `DEEPSEEK_API_KEY` + replay interception instead of disabling the adapter row.** Rejected despite zero composition change and two in-tree precedents: it satisfies `llm-deepseek`'s fail-loud key check with a lie and leaves a dead adapter mounted-but-intercepted; the disabled row (the ACP overlay's move) is honest keylessness and fails loud at the earliest resolvable point.

**A `packages/support/web-snapshot` package with a `defineWebSnapshotSuite` factory.** Rejected: chromium-driving source cannot honestly hold per-file 100% coverage on browserless coverage runners, and at two scenarios a factory generalizes from one consumer while the genuinely shared logic is already exported from gated packages. Re-entry trigger: a second web-shaped consumer or ≥6 scenarios with demonstrably drifting inline branches; the package boundary would then be drawn browser-free.

**A committed normalized-session-log golden as a second expected surface.** Rejected: the log surface is pinned by the ACP/headless/TUI suites through the same loop and persistence; here it would double refresh cost and re-test lower tiers. Inline world-state assertions on root-context events keep the world-verification duty.

**Spawning the `dsh web` bin with a `DSH_SNAPSHOT` replay branch.** Rejected: it needs a test-only replay branch plus environment plumbing in the shipped CLI. The in-process scaffold already loads the same `apps/cli/cordis.yml`; only argv, profile JSON, and `AppCLIEntry` glue remain outside it, and the keyless CLI smokes cover those paths.

**Changing the wire protocol for testability.** Rejected: the contract already has a first-class keyless isomorphic seam (`InProcessApiClient(toFetchHandler(api))`), the per-event unbatched SSE is exactly what makes replay observable in a browser, and testing a wire we no longer ship would invert the tier's purpose.

**Real-model browser tests as the keyless lane.** Rejected: nondeterministic by construction; the surveyed cautionary case (open-webui) grew unbounded timeouts and was deleted. The with-key W5 smoke stays as the live-model complement.

**A client `data-dsh-busy` settled signal.** Deferred: the multi-condition settled polls proved sufficient at two scenarios and the host-side `whenIdle` barrier does the heavy lifting. Re-entry trigger: the first settled-poll flake, or a scenario needing a state the DOM does not expose.

## Testing

The lane itself: `pnpm run test:web` runs both scenarios keylessly alongside the existing smoke pair; `DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/<spec>` re-records a scenario's fixture against the live model; `DSH_SNAPSHOT=refresh` rewrites both aria goldens keylessly. `paceMs` validation, pacing floor, abort-during-pace, and both `assertConsumed` failure shapes are pinned in `packages/support/llm-replay/tests/llm-replay.spec.ts`.

## Deferred

- **Web header-class pin**: web fixtures tokenize `{{system}}`/`{{tools}}` everywhere and no scenario pins the web composition's prompt/tool schemas (`TODO(web-header-pin)` — the scaffold `recordFixture` JSDoc marks it). Following the TUI scrub-everywhere precedent; revisit when the web assembly's header diverges from the repl composition it mirrors.
- **CI browser provisioning**: reversal of the no-browser-in-CI ruling, staged criteria above (`TODO(ci-browser)`).
- **Follow-up-prompt-after-resume scenario**: the history/live stitch path over the real wire; add as its own scenario when that code changes or regresses.

## Consequences

The web surface gains its record-once/replay-forever tier: the real chromium → SSE → apiproxy → loop → tools → persistence chain runs keylessly in ~10-30s, deterministic across repeat runs, with fixtures owned and re-recordable by the lane itself. Costs accepted: every intentional conversation-UI change ends with a keyless `DSH_SNAPSHOT=refresh` (golden churn is reviewed diff, anchors keep semantic green); the aria format is Playwright-owned — the one committed snapshot format the repo does not control — so playwright version bumps must be deliberate bump-and-refresh commits (the dependency floats `^1.49.0` in `apps/web/package.json`; pin exactly if churn bites); replay's first-call-order binding constrains scenarios to one prompting session each, with the consumption assertion as the tripwire; `compact-basic` shares the session's replay cursor and stays inert only under the published 128k catalog window; and the lane guards regressions only where it runs (locally, `test:web`) until the CI reversal is separately decided.
