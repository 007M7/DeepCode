# @deepseek-ai/dsh-tool-ralph

The model-facing `ralph` tool runs a fixed foreground workflow that gives one immutable objective to a sequence of fresh child agents. It demonstrates a specialized orchestration policy as an ordinary plugin over [`ctx.workflows`](../workflow/README.md) and [`ctx.subagents`](../../subagent/subagent/README.md): no Ralph mode or fresh-agent loop is added to `agent-loop`, and the same-session [goal domain](../../goal/goal/README.md) remains independent. The [Ralph Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) owns the policy and deferred work.

## Contract

`ralph({ objective, maxRounds? })` waits for the entire run. The deployment config's `maxRounds` is both the default and a ceiling on a call override. Every Ralph round starts one child through `subagentProvider`; that provider must exist, support structured output, and report `inheritsParentContext: false`. The configured provider is carried as `WorkflowStartRequest.subagentProvider`, so the fixed script cannot inspect or change routing and the ordinary model-written `workflow` tool gains no provider selector.

Each child receives only the immutable objective, its current Ralph round and cap, a shared-workspace-as-authority instruction, and the previous structured handoff. The workspace is long-term memory; parent conversation and prior child sessions are not seeded. Reports have `status: continue | complete | blocked`, a non-empty summary, evidence, next steps, and blocker text. Status-specific semantics and the serialized `maxHandoffChars` ceiling are validated inside the fixed workflow and again at the consumer boundary. Invalid, missing, or oversized reports fail the workflow instead of being truncated or mistaken for cap exhaustion.

The terminal tool result is `complete`, `blocked`, or `budget-limited`, with the last bounded report and number of rounds started. Child self-declaration determines completion in this cut. A workflow failure or cancellation is an error result; partial output is never success.

## Lifecycle and cancellation

The caller's agent is the parent of every fresh child, preserving cwd and lineage without copying its conversation. `exec.signal` enters the workflow engine and is also bridged to `run.cancel()` for implementation independence. The tool awaits `run.result` and calls `run.dispose()` in `finally`, so a cancelled parent step waits for the engine's bounded termination and child quiescence before returning.

## Render intent

The pending call is a `generic` card titled `ralph`; the immutable objective is its `rawInput`. The result keeps the generic card. Both presentation functions depend only on tool arguments and the settled tool envelope.

## Config

| Key | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | Fresh structured-output provider used for every round. |
| `maxRounds` | `256` | Default and deployment ceiling for one Ralph run. |
| `maxHandoffChars` | `16384` | Maximum serialized characters in one round report. |

All config values are normalized and validated when the plugin applies, including direct application outside Loader schema normalization. Provider capabilities are resolved immediately before each call because provider registration can change under plugin lifecycle and HMR.

## Model Experience

### System prompt

#### What the model sees

Every parent request in this plugin's registration scope receives the fixed routing guidance below.

##### Ralph guidance

```markdown
Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.
```

#### Token effect

Small fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schema

#### What the model sees

The generated [`ralph` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ralph) exposes one required `objective` string and one optional `maxRounds` number. Provider choice, handoff size, report schema, workflow script, and orchestration behavior are deployment-owned and absent from the call surface.

#### Token effect

Small fixed schema cost on each request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### Child requests and parent result

#### What the model sees

Each child sees the standalone fixed round prompt plus the structured-output capture contract. The parent sees only the original call and one terminal result containing status, round count, and pretty-printed final report; intermediate child messages and reports do not enter the parent conversation.

#### Token effect

Every round pays for a fresh child context. The parent result is bounded indirectly by `maxHandoffChars`; child work remains outside the parent context.

#### KV Cache effect

Each fresh child has an independent request cache. The parent result appends after the reusable request prefix.

## Known Limitations and Deferred Work

- **Completion is worker self-declaration** — there is no independent evaluator or verifier deciding whether the objective is actually complete; evaluator policy and evaluator-driven continuation are deferred.
- **Foreground only** — there is no task id, background collection, process-resume checkpoint, scheduler, or wall-clock start policy.
- **The workspace is the only cross-round long-term memory** — one bounded report is the explicit handoff, and uncommitted conversational reasoning disappears with each child.
- **One round is one fresh child** — there is no within-round fan-out, model/provider switching, fork context, or model-call-selected provider.
- **Only round count bounds aggregate effort** — token, price, and elapsed-time budgets are deferred.
