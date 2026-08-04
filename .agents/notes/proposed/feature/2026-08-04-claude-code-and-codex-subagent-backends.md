# Agent Note: Claude Code and Codex subagent backends

Status: proposed

English | [中文](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)

## Problem

The named [`ctx.subagents`](../../implemented/feature/2026-06-21-subagent-capability-seam.md) registry lets a parent agent delegate work without knowing how the child runs, but the harness needs first-party routes to the real Codex and Claude Code products. A useful first version must hand either product one self-contained task, let it work in the parent Session's workspace, return a final answer or an explicit failure or cancellation, and leave no managed product process behind.

The product integrations must not become second owners for task text, cwd, cancellation, result settlement, or process trees. Required keyless evidence therefore separates two facts: a real-product test proves the official protocol, native authentication shape, final answer, and teardown, while a Loader composition test proves that the public package and documented tool configuration load without starting the product. Direct model HTTP or a product double cannot replace the former; a hand-mounted plugin cannot replace the latter.

## Proposal

The harness publishes two sibling one-shot providers as independently installable, opt-in packages. A user loads a provider and the existing common subagent tool in their own `cordis.yml`: `subagent_codex` binds `codex`, while `subagent_claude_code` binds `claude-code`. The shipped CLI dependency closure and base, Web, and headless configurations load neither provider. Each tool accepts only a standalone text task; product selection and background execution are not model arguments.

The Codex provider is implemented against Codex 0.146.0. The Claude Code provider remains unimplemented. This Note remains proposed until both siblings and their combined evidence are present.

Both providers report `inheritsParentContext: false`, advertise no optional start capabilities, and pass the parent Session cwd without copying the parent conversation. Their documented tools disable background execution and use `maxDepth: 'provider-managed'`, leaving recursion policy with the out-of-process product instead of sending a limit the provider cannot enforce. Every call creates a fresh product process and a non-resumable product conversation. The shared subagent service continues to own request resolution, lifecycle events, result settlement, and foreground collection; the shared subprocess service owns credential scrubbing, process-tree termination, and whole-tree exit observation.

```text
fixed tool → shared subagent service → product provider → official product process
     ← final answer / explicit error / cancellation ← terminal product fact
     → foreground disposal → shared process-tree termination → whole-tree exit
```

### Ownership and lifecycle

| Phase | Shared owner | Product-specific responsibility | Observable result |
| --- | --- | --- | --- |
| Resolve | `dsh-tool-subagent` and `ctx.subagents` | Validate the product's text-only input and derive native startup parameters | Unsupported context or malformed input fails before a run is published |
| Start | `dsh-subprocess` owns every acquired process tree | Reach the smallest native point at which the product conversation and process can both be controlled | `start()` publishes one existing `SubagentRun`, or cleans up and rejects |
| Run | The product owns its native protocol facts; the holder owns their mapping | Submit exactly one task and derive an existing shared stop reason; Codex uses `max-tokens` only for explicit context exhaustion | The parent receives only a final answer or an explicit failure |
| Dispose | The foreground consumer requests release; `dsh-subprocess` proves exit | Close the native protocol and express any best-effort native cancellation | Disposal is idempotent and returns only after the whole process tree exits |

## Codex provider

`@deepseek-ai/dsh-subagent-codex` registers the fixed `codex` provider and always starts `codex app-server --stdio` from `PATH`. Its public configuration contains only an explicit `env` overlay and a positive finite `disposeGraceMs`. Installation, login, `CODEX_HOME`, model selection, base URL, sandbox, approval policy, and product-session settings remain native Codex or deployment responsibilities.

Before publication, the provider validates a non-empty text-only task, starts the managed app-server in the parent workspace, completes `initialize` → `initialized`, and creates an `ephemeral: true` thread. The published run owns exactly one `turn/start`; its thread and turn ids remain private and are never persisted in the parent Session.

`turn/completed` is the authoritative remote terminal fact. The latest nonblank `agentMessage` with `phase: "final_answer"` wins. When the product emits no explicit final phase, the latest message with `phase: null` is the compatibility fallback; commentary never replaces either answer. A failed turn with `error.codexErrorInfo: "contextWindowExceeded"` becomes `max-tokens`. A completed turn without an answer, every other failed or interrupted remote turn, malformed wire data, protocol closure, early process exit, or unknown server request becomes `error`; this version has no native refusal terminal and therefore produces no `refusal`. Local cancellation wins its race and remains `aborted`.

For command and file approvals, the unattended wire selects a non-approval decision offered by the request, preferring `cancel`; the stable 0.146.0 request shape without an offered-decision list falls back to `decline`. It grants no requested permissions for the turn, answers user-input requests with no answers, and declines MCP elicitation. A request with no legal unattended response, or any unknown server request, fails the run instead of waiting for a user interface the provider does not supply.

An unpublished startup failure closes the wire, terminates the acquired process tree, waits for exit, and then rejects `start()`. Published disposal best-effort interrupts a known turn, closes the wire, ends stdin, invokes the shared termination escalation, and waits for whole-tree exit. Result failure and teardown failure stay independently observable.

## Claude Code provider

The Claude Code sibling is not yet implemented. Its product version, official integration, terminal mapping, product-specific configuration, interaction policy, and evidence are not fixed by this intermediate proposal. Its eventual implementation must preserve the shared fixed-name, standalone-task, parent-cwd, shared-result, and managed-tree boundaries above before this Note can become implemented.

## Evidence contract

Each product owns branch-complete package tests, a required real-product spec, and a Loader composition e2e. The real-product tier uses the exact official distribution under test, a non-empty fake product key, an isolated temporary workspace and product home, and a loopback fixed-answer model. Missing product requests, wrong authentication, altered task text, a non-exact answer, a skipped real product, or a surviving managed handle fails the required test. The separate Loader tier boots the README-shaped user configuration, verifies the fixed provider and foreground-only common tool, and must not start a product process.

The Codex evidence pins `@openai/codex@0.146.0` and `codex-cli 0.146.0`. Its real-product spec observes the exact Bearer key, original task, byte-exact final answer, unattended command rejection with no file side effect, local cancellation, and whole-tree exit. Its Loader e2e resolves `@deepseek-ai/dsh-subagent-codex` by package name, verifies the `codex` registration and `subagent_codex` schema with background omitted, accepts `maxDepth: 'provider-managed'`, and records zero child starts while no `codex` command is available. The npm package is a development dependency for reproducible real-product evidence; production still supplies `codex` on `PATH`.

The combined contract is complete only when the Claude sibling has equivalent real-product evidence and both public Loader configurations prove the fixed tools use the unchanged common subagent contract.

## Alternatives considered

**Direct model HTTP, `codex exec`, or a hand-written Claude CLI protocol.** These paths bypass the products' official extensible integration surfaces and cannot prove native configuration, tools, approvals, result semantics, or teardown. Each provider uses its official product integration instead.

**A shared product-process helper package.** The existing subagent and subprocess seams already own every shared task, result, environment, and process-tree concern. A new helper would duplicate ownership before the two products demonstrate a missing common contract, so each private adapter calls the existing seams directly.

**A model-visible product selector.** Product availability and authentication are deployment facts. Two fixed tools keep each schema and provider binding explicit and avoid adding dynamic selection state to the common service.

**Product doubles as required evidence.** Doubles are useful for exhaustive private protocol branches but do not prove package exports, official binaries, authentication, or real process behavior. Required evidence drives each official product against a loopback model fixture.

**Plugin-managed login, product home, models, or permissions.** Those settings would create another authority beside each product's native configuration and enlarge a one-shot provider into account management. The providers expose only an explicit environment overlay and teardown grace; unattended interaction fails closed.

**Continuation, progress, background collection, and shared parent context.** The first user result needs one self-contained task and one final answer. Product sessions, resume, follow-up, intermediate messages, parent transcript transfer, structured output, and background collection need separate user contracts and are not prebuilt.

## Acceptance criteria

Both public provider packages load from user-owned Cordis configurations and form their fixed foreground tools without appearing in the shipped CLI defaults. Separate required real-product specs return exact final answers or explicit failure or cancellation and prove managed process-tree quiescence. Both packages document their configuration, lifecycle, failure behavior, model experience, and limitations; generated package, configuration, capability, dependency, and third-party records agree with the shipped manifests.

The implemented Codex half satisfies this contract for its fixed tool and 0.146.0 baseline. The proposal becomes implemented only after the Claude Code sibling and the combined two-product evidence satisfy the same ownership and lifecycle boundaries.

## Risks

- The product protocols are versioned and may change. Production performs no runtime version probe, so every supported baseline change requires refreshed compatibility evidence.
- Product-native configuration makes behavior depend on the deployment's installed product and account state. Required tests isolate those inputs, while production deliberately leaves them under the product's authority.
- Every delegation pays for a fresh process and independent model context, and only final text reaches the parent.
- Product tool or file side effects are not rolled back when a run fails or is cancelled.
- Unattended interaction denial prevents hidden approval hangs but cannot satisfy tasks that require new permission or human input.
