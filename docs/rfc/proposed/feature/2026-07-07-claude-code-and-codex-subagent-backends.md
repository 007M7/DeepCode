# RFC: Claude Code and Codex subagent backends (out-of-process delegation to external coding agents)

Status: proposed

## Problem

Add isolated subagent providers for Claude Code and Codex. The existing [named-provider seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md) and [ACP backend](../../implemented/feature/2026-06-22-acp-subagent-backend.md) establish the process-boundary shape. A harness turn should be able to delegate a self-contained task to either product and receive its final answer without exposing parent secrets or inheriting host configuration from `~/.claude` or `~/.codex`.

## Proposal

Two sibling provider packages, structural variants of the ACP backend, plus one extraction:

- `@deepseek-ai/dsh-subagent-claude-code` — drives a Claude Code child through `@anthropic-ai/claude-agent-sdk`'s `query()` (the SDK runs in the parent process and spawns its bundled `claude` CLI as the subprocess). Provider name `claude-code`: the child is the Claude Code *product*, not an Anthropic model adapter — "claude" stays reserved for a future `dsh-llm` adapter.
- `@deepseek-ai/dsh-subagent-codex` — spawns `codex app-server` and drives one thread/turn over its JSON-RPC-over-stdio protocol with a hand-rolled newline-JSON client (~200–300 lines) in the package.
- `@deepseek-ai/dsh-subagent-process` — a pure library (the `subagent-inprocess` precedent) extracting what `dsh-subagent-acp` already carries and both new backends need: the credential env scrub (`SENSITIVE_ENV_PATTERN`/`buildChildEnv`), the EOF → SIGTERM → SIGKILL dispose ladder, and new isolated-config-dir helpers (`mkdtemp` create, best-effort remove). The ACP backend migrates onto it; `bash-local`'s sibling copy is left alone to bound the change.

Both providers follow the ACP backend contract: a fresh child per `start`, one prompt round-trip, no inherited parent context or advertised optional capabilities, ignored `request.parent` and `request.agentOptions`, and a random branded agent id. `result` never rejects; child failures map to stop reasons while the original error reaches the logger. Each mounts `dsh-tool-subagent` under a distinct tool name. The tool result is the only new model-visible artifact, so no new session event is required; workspace mutations remain ambient side effects outside transcript replay.

## Verified interface facts (pinned versions)

Both integration surfaces were verified against pinned implementations before this proposal — types and bundled source read, keyless spikes run — not from vendor docs alone. The pins are the verification baseline, not a runtime contract: the backends perform no runtime version probe (no `codex --version` gate, no SDK version sniffing). Compatibility is enforced at development time — every dependency bump re-runs the keyless suites against the real load path — and at runtime by failing loudly: a protocol-level surprise settles `error` via `onError`, never a silent misbehavior.

**`@anthropic-ai/claude-agent-sdk` 0.3.202.** `options.env` REPLACES the child environment (no merge with `process.env`), which is exactly what the scrub needs. `settingSources` defaults to loading ALL filesystem settings — isolation requires explicitly passing `[]`. Result subtypes are `success` | `error_during_execution` | `error_max_turns` | `error_max_budget_usd` | `error_max_structured_output_retries`. On abort the SDK escalates the CLI child itself: stdin EOF immediately, SIGTERM ~2s later if the child ignores it (observed; no leftover processes) — no bespoke kill fallback needed. `outputFormat: {type: 'json_schema'}` and an `agents` option exist, giving future landing points for the seam's `outputSchema` capability and named subagent types; both are out of scope here.

**codex CLI 0.142.5, `codex app-server` (v2 vocabulary).** LF-delimited JSON, JSON-RPC 2.0 shapes with the `"jsonrpc"` header omitted.

- Lifecycle: `initialize{clientInfo}` + `initialized` → `thread/start` (accepts `cwd`, `model`, `sandbox`, `approvalPolicy`, `ephemeral`; succeeds unauthenticated) → `turn/start{threadId, input:[{type:'text',text}]}` returns an `inProgress` turn immediately; the terminal signal is the `turn/completed` notification carrying `Turn{status: completed|interrupted|failed|inProgress, error}`.
- Approvals are server-initiated requests — `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request` — answered with `accept`/`decline`-family decisions.
- Auth: `account/login/start{type:'apiKey', apiKey}` is a first-class RPC and `account/read` reports `requiresOpenaiAuth` — and an unauthenticated `turn/start` does NOT fail fast (it hangs in retry), so the backend MUST pre-check auth and settle `error` loudly instead of waiting on the turn.
- Isolation: `CODEX_HOME` redirection is honored (the `initialize` response echoes it, so tests can assert isolation), and `ephemeral: true` threads leave no session files at all.

## Isolation and credentials

Authentication is API-key-only. Each run uses a fresh config directory (`CLAUDE_CONFIG_DIR` with `settingSources: []`, or `CODEX_HOME`) that is removed best-effort on dispose; config may instead select a persistent directory. The shared child-env helper forwards ordinary values such as `PATH`, `HOME`, `TMPDIR`, locale, and proxy settings, removes credential-shaped names, and overlays explicit `config.env`. Claude Code receives its API key through that overlay, while Codex receives it through `account/login/start` rather than a hand-written auth file.

## Permission and approval policy

Each backend exposes its engine's native policy vocabulary. Claude Code defaults to `permissionMode: default` with `permission: reject`; Codex defaults to `sandboxMode: read-only`, `approvalPolicy: never`, and the same rejected fallback. Examples opt into `acceptEdits` or `workspace-write`. Known approval, user-input, and elicitation requests receive the configured answer; unknown methods receive method-not-found and unknown notifications are consumed. No prompt reaches a human, and no child can wait indefinitely for unavailable input.

## StopReason mapping

Claude Code: `success` → `completed`; `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries` → `error` (aligning with the ACP call on `max_turn_requests`: an unfinished task is not success); generator abort → `aborted`; anything unknown → `error`. Codex: `Turn.status` `completed` → `completed`; `interrupted` → `aborted`; `failed` with `codexErrorInfo: 'contextWindowExceeded'` → `max-tokens`, any other `failed` → `error`; transport/spawn/auth-precheck failure → `error` (or `aborted` if cancel was requested). In both, `cancel()` is the ACP shape: flag + abort/interrupt + a cancel-settled race arm so an uncooperative child cannot stall the result.

Liveness posture, stated explicitly: teardown timing is config, turn duration is not. Both backends take the dispose ladder's grace periods as defaulted validated config fields (the ACP backend's `disposeEofGraceMs`/`disposeGraceMs` shape, carried by the extraction), but there is deliberately NO turn-duration or startup timeout — matching ACP, liveness during a turn belongs to the caller via `cancel()`/the abort signal, a subagent turn is legitimately minutes long, and the Codex auth precheck removes the one verified guaranteed-hang; a deployment wanting a wall-clock bound cancels from the parent.

## Testing

Coverage is required at each applicable tier:

- **Keyless unit/integration:** drive a fake Claude CLI through the real SDK and a scripted Codex app-server through the real wire client. At per-file 100% coverage, exercise round trips, every stop mapping, both cancellation paths and pre-abort, permission policies, unknown messages, spawn failure, reload cleanup, export shape, scrubbed environments, temporary-directory removal, and Codex auth precheck failure.
- **With-key e2e:** each real engine performs file work under `acceptEdits` or `workspace-write`; skips name the missing binary or key and assert no child process remains.
- **Snapshot:** deferred as `TODO(claude-code-subagent-replay)` and `TODO(codex-subagent-replay)` pending the process-specific replay shape described by the [subagent replay RFC](../../implemented/testing/2026-06-22-subagent-snapshot-replay.md).

## Alternatives considered

### Why not the official `@openai/codex-sdk` instead of a hand-rolled client?

The dispose ladder and env scrub require owning the child process (spawn args, env, signals, exit await); the SDK hides the process. The wire format is trivial to frame (LF JSON), the shapes are generatable per pinned version (`codex app-server generate-json-schema`), and the repo precedent (`hook-protocol`) is to own thin protocol cores rather than wrap someone's runtime. The SDK would save protocol-evolution maintenance but costs the exact control this backend exists to have.

### Why not a model-visible `subagent_type` parameter (one Task-style tool)?

Claude Code's own Task tool puts the subagent type in the model-facing schema, selecting a prompt-plus-toolset persona. Here the choice is between EXECUTION ENGINES, and only the deployer knows which engines have credentials configured — so selection stays deployment config, preserving `dsh-tool-subagent`'s documented one-provider-per-tool contract. A persona-style type selector would be a separate RFC against the tool, not the backends.

### Why not login-state credentials and the user's own config?

Inheriting `~/.claude` / `~/.codex` (subscription login, user settings, skills, MCP servers) would make child behavior depend on host-machine state and punch an implicit exception through the "credentials enter explicitly via `config.env`, never ambiently" rule the ACP backend and bash executor established. API-key-only plus forced config-dir isolation keeps runs reproducible; deployments wanting shared state can point the config-dir field at a persistent directory deliberately.

### Why not a driver-injection seam for the Claude Code keyless tests?

Injecting a fake `query()` would mock our own boundary and leave the real SDK load path untested (the real-over-mock policy in docs/testing.md). The risk that justified considering it — the SDK↔CLI stream-json control protocol being internal — was retired by the spike: the fake-CLI harness works against the real pinned SDK today. If an SDK upgrade breaks the mock, the keyless suite fails the upgrade PR, which is the gate working.

### Why not ACP adapters (e.g. `claude-code-acp`) reusing the existing backend?

Community shims wrap both engines in ACP, which would make them "just config" on `dsh-subagent-acp`. But that inserts an unofficial third-party layer between the harness and the engine, erases the native control surfaces this RFC exposes (permissionMode, sandboxMode/approvalPolicy, config-dir isolation, apiKey RPC), and trades first-party protocol stability for a shim's release cadence. First-party surfaces — the Agent SDK and the app-server — are the supported integration points.

## Acceptance criteria

On a machine with both engines and keys configured: a REPL-driven model completes one real file task through `subagent_claude_code` and one through `subagent_codex`, the tool result being the child's final answer, with only `tool/call` + `tool/result` in the parent session log. Keyless suites pass at 100% per-file coverage in a credential-less environment, asserting isolation (scrubbed child env, no temp config dirs left after dispose) and that child behavior is unchanged by the presence or absence of `~/.claude` / `~/.codex`. Cancelling a parent turn quiesces both backends in bounded time with no leftover child processes. E2e suites self-skip cleanly, naming the missing prerequisite.

## Risks

- `codex app-server` is CLI-flagged experimental and its v1/v2 vocabularies coexist; the client pins 0.142.5, implements v2 only, and consumes unknown methods/notifications without crashing, but a future codex bump can still force rework (regenerate schemas and re-run the keyless suite on every bump — the development-time enforcement behind the no-runtime-version-probe stance above).
- The Claude Code fake-CLI mock rides an internal protocol: any SDK upgrade must go through the keyless suite, and a breaking control-protocol change means reworking the mock (fallback: the driver-injection seam rejected above becomes the escape hatch).
- The SDK's optionalDependencies weigh ~280MB per platform — accepted, and confined to the one backend package.
- The SDK's SIGKILL branch beyond EOF→SIGTERM was not observed and is trusted; e2e keeps a no-leftover-process assertion.
- Codex is a deployment prerequisite (no npm-bundled binary); a missing or incompatible binary surfaces as a loud spawn/protocol `error`, not a version probe.
- Every run pays a fresh child process and only the final answer surfaces — thoughts, tool cards, and usage are consumed and dropped; pooling, intermediate-progress surfacing, `sendMessage`/`resume`, `outputSchema` via the SDK's `outputFormat`, and named subagent types via the SDK's `agents` option are all deliberate deferrals.
