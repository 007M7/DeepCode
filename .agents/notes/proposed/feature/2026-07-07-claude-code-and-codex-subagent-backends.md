# Agent Note: Claude Code and Codex subagent providers

Status: proposed

English | [中文](2026-07-07-claude-code-and-codex-subagent-backends.zh.md)

## Problem

The named [`ctx.subagents`](../../implemented/feature/2026-06-21-subagent-capability-seam.md) registry lets a parent agent delegate work without knowing how the child runs, but the harness needs first-party routes to the real Codex and Claude Code products. A useful first version must hand either product one self-contained task, use the parent Session's workspace, return a final answer or explicit failure, and leave no managed product process behind.

Product integration must not create a second owner for task text, cwd, cancellation, result settlement, or process trees. It must also prove the real product path in required keyless tests: a fake wrapper or direct model HTTP request cannot establish that the Loader, provider registration, official product protocol, authentication, final answer, and teardown compose correctly.

## Proposal

Two sibling one-shot providers register fixed deployment names and are exposed through two fixed `dsh-tool-subagent` instances:

- `@deepseek-ai/dsh-subagent-codex` registers `codex`, driven through `codex app-server --stdio`, and is implemented.
- `@deepseek-ai/dsh-subagent-claude-code` will register `claude-code`, driven through the official Claude Agent SDK and its bundled CLI, and remains pending.

The model-facing tools are `subagent_codex` and `subagent_claude_code`. Each tool binds one provider at deployment time, accepts a standalone task, and omits the background parameter in the initial compositions. Product selection is not another model argument.

Both providers report `inheritsParentContext: false`, advertise no optional start capabilities, and use the parent Session cwd without copying the parent conversation. Every call creates a fresh product process and one non-resumable product conversation. The shared subagent service continues to own request resolution, lifecycle events, result settlement, and foreground disposal; the shared subprocess service owns environment scrubbing, process-tree termination, and whole-tree exit observation.

## Codex provider

The Codex provider has fixed name `codex` and fixed command `codex app-server --stdio`. Its public configuration contains only explicit `env` entries and a positive finite `disposeGraceMs`; it does not expose command, cwd, model, base URL, API key, sandbox, approval, product home, or session settings. Production resolves Codex from `PATH` and uses the host's native Codex configuration and authentication. Credential-shaped ambient variables are scrubbed by `dsh-subprocess`, while explicit `env` values merge afterward.

Before publication, the provider validates a non-empty text-only task, starts the managed app-server, performs `initialize` → `initialized`, and creates an `ephemeral: true` thread in the parent workspace. The returned run owns exactly one `turn/start`; product thread and turn ids stay private and are not persisted in the parent Session.

`turn/completed` is the authoritative remote terminal fact. The latest nonblank `agentMessage` with `phase: "final_answer"` wins, with the latest nullable-phase message as the compatibility fallback; commentary never replaces an answer. A completed turn without an answer, a failed or interrupted remote turn, malformed payload, protocol closure, early process exit, or unknown server request becomes a shared `error`. Local cancellation wins the race and remains `aborted`.

The unattended wire declines command and file approvals, grants no requested permissions for the turn, and declines MCP elicitation. It fails closed for every other server request instead of waiting for UI that this provider does not supply.

Publication transfers the wire and process handle to one holder. Idempotent disposal best-effort interrupts a known turn, closes the wire, ends stdin, invokes the shared termination escalation, and waits for whole-tree exit. An unpublished startup failure performs the same cleanup before `start()` rejects.

## Claude Code provider

The Claude Code sibling follows the same fixed-name, self-contained, one-shot, parent-cwd, shared-result, and managed-tree boundaries. Its product-specific implementation will use the official Agent SDK's `query()` and spawn hook, keep SDK protocol ownership separate from `dsh-subprocess` process-tree ownership, omit human-interaction callbacks, and derive only a strict final SDK result after the message iterator ends normally.

The Claude package will expose the same two configuration concerns, `env` and `disposeGraceMs`. Product installation, native settings, and login remain deployment responsibilities rather than plugin-managed state. This note stays proposed until that sibling and the combined two-product evidence are implemented.

## Evidence contract

Each product owns package-level branch-complete tests, a required real-product spec, and a real Loader snapshot. The real-product tier must use the exact official distribution under test, a non-empty fake product key, an isolated temporary workspace and product configuration, and a loopback fixed-answer model; it fails rather than skips when the binary, authentication request, task, answer, cancellation, or process-exit proof is missing.

The Codex evidence pins `@openai/codex@0.146.0` / `codex-cli 0.146.0`. Its real-product spec observes the exact Bearer key, original task, byte-exact final answer, unattended command rejection with no file side effect, local cancellation, and every managed handle reaching whole-tree quiescence. Its Loader snapshot fixes the no-background tool schema, exact tool call and result, full persisted parent Session, product request, and pre-teardown quiescence. The npm package is a development dependency for reproducible evidence; production still uses `codex` from `PATH`.

## Alternatives considered

**Direct model HTTP or `codex exec`.** These paths bypass the products' official extensible process protocols and cannot prove product configuration, tools, approvals, lifecycle, or teardown. The providers use app-server and the official Agent SDK instead.

**A shared product-process helper package.** The existing subagent and subprocess seams already own every shared task, result, environment, and process-tree concern. A new helper would duplicate ownership before two production consumers demonstrated a missing common contract, so product-specific adapters call the existing seams directly.

**A model-visible product selector.** Product availability and authentication are deployment facts. Two fixed tools keep each schema and provider binding explicit and avoid adding dynamic selection state to the common service.

**Product doubles as required evidence.** Doubles are useful for exhaustive private protocol branches but do not prove package exports, official binaries, authentication, or real process behavior. Required evidence drives the official product against loopback model fixtures.

**Plugin-managed login, product home, models, or permissions.** Those settings would create another authority beside each product's native configuration and enlarge a one-shot provider into account management. The providers expose only explicit environment overlay and teardown grace; unattended interaction fails closed.

**Continuation, progress, and shared parent context.** The first user result needs one self-contained task and one final answer. Product sessions, resume, follow-up, intermediate messages, parent transcript transfer, structured output, and background collection need separate user contracts and are not prebuilt.

## Acceptance criteria

The proposal is complete when both fixed tools reach their corresponding real products through the Loader, return exact final answers or explicit failure/cancellation, persist the complete model-visible parent transcript, and prove managed process-tree quiescence in required keyless CI. Both packages have complete configuration, lifecycle, failure, model-experience, and limitation documentation; the generated package, configuration, capability, dependency, and third-party records agree with the shipped manifests.

The implemented Codex half already satisfies this contract for its fixed tool and 0.146.0 product baseline. The note remains proposed because the Claude Code sibling and combined final evidence are not yet implemented.

## Risks

- The Codex app-server protocol is product-versioned and may change; production performs no runtime version probe, so every supported baseline change must refresh schema investigation and real-product compatibility evidence.
- Product-native configuration makes behavior depend on the deployment's installed product and account state. Required tests isolate those inputs, while production deliberately leaves them under the product's own authority.
- Every delegation pays for a fresh process and independent model context, and only final text reaches the parent.
- Product tool or file side effects are not rolled back when a run fails or is cancelled.
- Unattended approval denial keeps the initial provider safe from interactive hangs but cannot satisfy tasks that require new permission.
