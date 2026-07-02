# @deepseek-ai/dsh-hook-protocol

The **shared core** of the Claude Code / Codex hook wire protocol. NOT a cordis plugin — it registers nothing and injects nothing. It is a **library** of dialect-neutral primitives the two bridge plugins (`@deepseek-ai/dsh-hooks-claude`, `@deepseek-ai/dsh-hooks-codex`) import so neither re-implements the identical halves of the protocol.

Why a shared lib at all: Codex deliberately reimplements a *subset* of the Claude Code hook protocol — the same `hooks.json` matcher-group shape, the same exit-code/stdout output contract, the same command-hook execution model. The genuinely-shared parts live here; each bridge owns only what differs.

## What's shared (here) vs. per-dialect (the bridges)

| Concern | Here (`dsh-hook-protocol`) | The bridge (`dsh-hooks-claude` / `-codex`) |
|---|---|---|
| Matcher test | `matchesMatcher(pattern, query, mode)` — literal-or-regex by `mode` | picks its `mode` (`claude` = literal-or-regex, `codex` = always regex) |
| Run a hook | `runHook(bash, hook, opts, now)` — stdin payload + env via `ctx.bash`, decode | builds the per-event stdin **payload** + the dialect's **env** |
| Decode output | `parseHookOutput(exit, stdout, stderr)` → neutral `HookOutput` | maps the neutral `HookOutput` onto a seam-specific typed Decision |
| Merge N hooks | `mergeHookOutputs(outputs)` → most-restrictive `MergedHookOutcome` | — |
| Durable record | `appendHookInvoked` / `appendHookResult` (`hook/*` session events) | calls them around each invocation |

## Primitives

- **`matchesMatcher(matcher, query, mode)`** — match-all on absent/`''`/`'*'`; `claude` mode treats a pure `[A-Za-z0-9_|]+` pattern as a literal (pipe = exact-match alternation) and anything else as a regex; `codex` mode is always an unanchored regex. An invalid regex matches nothing (never throws).
- **`runHook(bash, hook, options, now)`** — serialize `options.payload` to the hook's stdin (with a trailing newline iff `options.trailingNewline`), merge `options.env` after the executor's credential scrub (the `dsh-bash` trusted-plugin surface), honor the hook's `timeoutSec` (else `defaultTimeoutMs`), and decode the result (threading `options.expectedEventName` to the codec). Never throws: an executor rejection (infra fault) becomes a `HookOutput` with `exitCode: undefined` (a non-blocking error). `now` is injected for testable durations.
- **`parseHookOutput(exitCode, stdout, stderr, expectedEventName?)`** — the exit-code + structured-stdout codec. Exit `0` → parse JSON stdout (lenient: non-JSON is left for the bridge); exit `2` → blocking error, `stderr` is the block reason (surfaced as `decision: 'block'`); other → non-blocking error. `hookSpecificOutput.permissionDecision` (allow/deny/ask) overrides a legacy top-level `decision`; `additionalContext`/`updatedInput`/`systemMessage`/`continue`/`stopReason`/`suppressOutput` are parsed too. The schemas key the `hookSpecificOutput` block by `hookEventName`, so passing `expectedEventName` (the firing event) DISCARDS a block whose `hookEventName` names a different event — or omits it entirely — its event-scoped fields don't take effect (a `PreToolUse` block on a `Stop` hook is malformed, and so is a discriminator-less block that would otherwise apply to any event), while the event-agnostic top-level fields still apply. Pure and total.
- **`mergeHookOutputs(outputs)`** — fold the results of every hook that matched one point: permission precedence **deny > ask > allow**, halt sticky on the first `continue:false`, block reasons joined with `\n\n`, `additionalContext`/`systemMessages` accumulated in order.

## `hook/*` session events

Declaration-merged into `SessionEventMap` (log-only, like `compact/*` — NOT a `SurfaceEventType`, no `surfaceOp`):

- `hook/invoked` — `{ turn, point, dialect, matcher?, handlerId }`: a hook command ran.
- `hook/result` — `{ turn, point, handlerId, decision, exitCode?, stderrSummary?, durationMs }`: its outcome, paired by `handlerId`.

Like every event they must sit inside an open turn. The mid-turn points (`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`) fire inside the loop's open turn by construction; `SessionStart` gets no `hook/*` record (its injected `context/message` is the durable evidence) — see the hooks RFC.

## Input rewrite is parsed but not honored

`HookOutput.updatedInput` carries a hook's requested tool-input rewrite (CC `updatedInput`), but the harness does not honor it yet — input rewrite is a deferred consistency-design problem ([the pre-tool-input-rewrite RFC](../../../docs/rfc/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)). A bridge logs + warns when a hook sets it. See `src/types.ts` for the full contracts.
