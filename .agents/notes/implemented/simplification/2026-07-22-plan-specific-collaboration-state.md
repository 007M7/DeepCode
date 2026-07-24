# Agent Note: Collapse named session modes into plan mode

Status: implemented

English | [中文](2026-07-22-plan-specific-collaboration-state.zh.md)

## Problem

The first plan-mode implementation introduced a generic named-mode registry even though the product shipped only `plan`. `ModeConfig.modes`, definition-name validation, `ctx.modes.list()`, retired-definition fallback, and a synthetic `review` mode in tests existed only to support hypothetical future collaboration modes. The production-specific behavior—plan guidance, `/plan`, and `exit_plan_mode`—still lived in the same package, so the generic API did not isolate a reusable mechanism from plan policy.

The word “mode” also spans unrelated domains. Sandbox mode is an enforcing policy owned by `ctx.sandboxPolicy` and logged as `sandbox/mode`; plan mode is a collaboration stance that contributes guidance and a reviewed exit. Treating both as instances of one named-mode abstraction would obscure their independent ownership. A transport's generic vocabulary is not evidence that the harness needs a generic mode domain.

## Decision

Plan mode owns a plan-specific product package: `@deepseek-ai/dsh-plan-mode` at `packages/plan/plan-mode/`. The durable fact is `plan/mode: { active: boolean }`, folded by `foldPlanMode(events)` with `false` as the empty-log value. `ctx.planMode.get(agent)` returns `{ active, pending? }`, and `set(agent, active)` records the boundary-applied selection. The existing prompt-submit, continuation, retry, append-failure, and disposal fences remain unchanged in meaning.

Configuration is exactly `{ section: string }`. The package registers the fixed `plan:policy` section, `/plan [message]`, the exact `/plan off` direct-exit form, and `exit_plan_mode` itself. Bare `/plan` selects active; another non-empty argument selects it first and then sends the trimmed text through `agent.steer()`, making the text an ordinary logged user message in the affected step. `/plan off` selects inactive without model input and can cancel an entry that is still pending at the boundary. The exit tool remains registered while plan mode is inactive so the request tool catalog stays stable.

Human-facing compositions own plan selection and review. This note originally kept ACP's protocol-level `default`/`plan` picker as an adapter over the boolean service; [ACP as an automation-only protocol](2026-07-23-acp-automation-only-protocol.md) supersedes that wire projection, so the ACP composition now mounts neither plan mode nor a mode-selection protocol.

Sandbox mode and approval policy remain separate enforcement axes. Plan mode neither reads nor writes them, and the simplification introduces no shared base type, registry, or preset abstraction across those concepts.

## Deleted surface

- The arbitrary definition map, mode-name regular expression, reserved-name rules, and per-definition command loop.
- `ModeDefinition`, the resolved definition map, `ctx.modes.list()`, string-valued get/set state, and unknown or retired mode handling.
- Test-only `review` mode cases and claims that additional modes can be added through configuration.
- Generic `mode/set` and `mode:policy` names; the plan package now owns `plan/mode` and `plan:policy`.

## Alternatives considered

**Keep a private generic registry and expose only plan today.** Rejected because the unused name/config machinery would still be maintained and tested without a second production consumer. A future collaboration state can establish the right shared seam from two concrete cases.

**Fold sandbox mode into the same service.** Rejected because collaboration guidance and execution confinement have different owners, lifecycle semantics, and consumers. Their shared English noun is not a domain relationship.

**Let one presentation transport own plan state.** Rejected because TUI, Web, resume, fork, prompt assembly, and the exit tool need the same logged fact independently of any one transport. Presentation adapters own only their projections.

## Verification

- Package tests retain boundary ordering, retry, append-failure, HMR disposal, prompt assembly, stable native and Code Mode schemas, review outcomes, and invariant coverage through the boolean service.
- Command tests cover bare `/plan`, `/plan <message>`, active `/plan off`, pending-entry cancellation, inactive idempotence, absence of `/mode` and `/review`, and effect-scoped removal.
- The keyless TUI scenarios enter through `/plan <message>`, leave through `/plan off`, and prove that each committed `plan/mode` precedes the request header it changes, the entry message is logged under plan guidance, and the post-exit request omits that guidance.

## Consequences

The implementation has one vocabulary for one shipped feature. Adding another collaboration stance is an explicit design decision instead of a config entry, and automation clients do not acquire human mode controls through ACP. The migration intentionally rejects old `mode/set` logs and old `modes.plan.section` configuration under the repository's pre-release format policy.
