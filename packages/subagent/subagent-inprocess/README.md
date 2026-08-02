# @deepseek-ai/dsh-subagent-inprocess

English | [中文](README.zh.md)

This package is the shared run driver for the two in-process providers' one-shot delegations. Spawn passes no session seed; fork passes the parent's completed-turn prefix. Everything else—depth, child creation, optional child customization, result reading, cancellation, and disposal—has one implementation here. Continuable children never come through this driver: the continuation manager in `@deepseek-ai/dsh-subagent` composes and drives them directly, so this driver owns exactly one turn with one result.

## Start contract

`startInProcessRun(request, options): Promise<SubagentRun>` fulfills as soon as the child is published in `ctx.agents`. A rejected start has already quiesced the agent factory's unpublished creation transaction, while turn or infrastructure failures after publication settle through the returned run without hiding the child id.

The driver follows this sequence:

1. Validate the parent depth and optional absolute `maxDepth`, then derive child depth as parent depth plus one and persist it together with `origin: 'subagent'` in the child session header. Origin is a coarse product-navigation classifier; the later descriptor remains lifecycle and continuation authority.
2. Mint a fresh child session id and call `parent.ctx.agents.create` directly, passing the optional fork seed and required request signal into the factory's creation transaction. During the unpublished setup window, install the requested persona, tool restriction, structured-output runtime, and a one-shot `agent/step` contribution that appends the resolved `subagent/descriptor` event after the initial `turn/start` and before the first request.
3. Publish the child, retain the returned `AgentHandle`, and return its holder-owned run. The run's `result` drives one task with `child.followup(prompt)` followed by `child.whenIdle()`.
4. Read the child's own last assistant message and latest message-triggered turn reason, excluding the fork seed prefix so a seeded parent message is never mistaken for child output.

The child gets the parent's working-directory/session lineage and inherits the parent provider, model, and output-token cap unless `request.agentOptions` overrides them. It gets a fresh flat registration scope: parent ownership does not import parent tool restrictions or establish an authority subset.

When the optional sandbox-policy or approval service is composed, the driver snapshots the parent's explicit session override before child creation and appends a source-tagged event during unpublished setup, after any fork history and before session publication. It never copies deployment defaults or one-shot grants; later child switches still win. See the [policy-inheritance decision](../../../.agents/notes/implemented/feature/2026-07-25-subagent-policy-inheritance.md).

## Cancellation and ownership

The required request signal covers both startup and the live run. Before publication, `AgentCreationTransaction` observes it, rolls back, and rejects. The factory detaches that creation-only listener before returning; the published run immediately installs its own listener and checks the signal again, closing the handoff race. Once publication has occurred, an abort preserves the returned child id, prevents unsubmitted work, and resolves an incomplete result as `aborted`; an abort during the turn cancels the child.

After fulfillment, the caller owns the run. Provider-plugin unload does not revoke it. `dispose()` removes the live abort listener, records cancellation, and awaits both `result` and the returned `AgentHandle.dispose()`; the handle's memoized quiescence transaction stops the loop, removes the agent and session, and unwinds scoped registrations. A result rejection remains on `result`; `dispose()` rejects only when handle disposal fails, after both operations settle. Cancellation owns every non-completed in-flight outcome and reports `aborted`; an already-completed turn remains completed.

## Spawn and fork inputs

`InProcessRunOptions` is `{ seed?: SessionEvent[] }`. Spawn omits it. Fork supplies a balanced completed-turn prefix and records its length so the result reader never mistakes a seeded parent message for child output.

Depth enforcement is internal to `startInProcessRun`: it reads the parent depth via `delegationDepthOf` (the persisted `SessionHeader.delegationDepth` is authoritative; runtime `AgentOptions.subagentDepth` may deepen but never lower it, so a resumed child keeps its budget), treats absence as top-level depth zero, rejects malformed stored values, and reports an attempted child depth above `maxDepth`. An unrepresentable depth above the safe-integer domain is a `RangeError`. The child depth is written to the child header, so it survives persistence and resume.

## Structured output

`attachStructuredRuntime(childCtx, schema)` installs the whole contract in the child's scope:

- A `structured_output` tool registered with the requested schema validates and stages the model's value.
- An order-190 system-prompt section tells the child that the tool call is the terminal answer.
- Both contributions are ordinary child-scoped registrations. An expert `system-prompt/assemble` listener may replace them and therefore owns preserving the structured-output protocol for that child.
- A `tools/result` observer commits a staged value only after that execution's authoritative final tool result succeeds, including the enclosing `run_code` result for Code Mode sub-dispatch.
- A monotonic tool guard blocks later calls after capture, and the structured-output execution's `concludeTurn()` marker ends the turn after the result commits.

A clean turn that never commits the required structured value reports `error`; the driver does not re-prompt. All registrations ride the child fiber and disappear with it.

## Model Experience

### Child-agent request

#### What the model sees

The shared driver sends the task verbatim as the child's user message and, when requested, shadows the persona and restricts global tool schemas, lookup, execution, and Code Mode SDK bindings in the unpublished child's fresh scope; parent restrictions are not inherited, and standalone tool-guidance sections remain. Spawn supplies no history; fork supplies its balanced seed.

#### Token effect

Child input is isolated from the parent and grows through the child's own steps. A persona changes repeated prompt text; filtering changes schema or generated SDK cost but not independently registered guidance.

#### KV Cache effect

Independent of the parent request cache. The child's later history is append-only, while persona, tool-filter, generated-SDK, provider, or model changes establish a different child prefix.

### Structured-output system prompt, schema, and results

#### What the model sees

A structured run adds the structured-output instruction below. It also adds a child-scoped `structured_output` definition with exact description `Report your final structured result. Call this exactly once, when your answer is complete; the arguments must match this tool's parameter schema exactly.` and the requested schema. This runtime-only definition is outside the generated shipped [tool package map](../../../docs/tool-catalog.md#tool-package-map). Its canonical acknowledgement is `{ recorded: true }`, rendered as `Structured output recorded.`; a later call becomes ``Error: structured output already recorded: the run is complete, so `<tool>` is not executed``.

##### Structured-output instruction

```markdown
When you have your final answer, you MUST report it by calling the `structured_output` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only the tool call counts as your result.
```

#### Token effect

Fixed instruction and capability tokens are paid only by that child. Result text enters the child history, while the captured value alone becomes the parent result.

#### KV Cache effect

Prefix-stable inside the child while the structured-output instruction and schema are unchanged. Changing the schema or capability may invalidate the child's cache from that early segment; results append in child and parent histories.

### Parent start error, indirectly

#### What the model sees

Through `dsh-tool-subagent`, invalid depth state becomes exactly `Error: agent subagentDepth must be a non-negative safe integer`, `Error: subagent child depth exceeds the safe-integer range`, or `Error: subagent depth <attempted> exceeds maxDepth <max>`. A pre-publication cancellation passes its abort reason through the registry's `Error: <message>` wrapper.

#### Token effect

Zero tokens on a successful start; only the failed parent tool call retains this text.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Parent result, indirectly

#### What the model sees

The driver extracts only the child's own last assistant output or captured structured value; seeded parent messages and intermediate child work do not become the result.

#### Token effect

The parent receives one data-dependent result through the consumer; all other child tokens stay in the child session.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Structured capture accepts the `defineTool` schema subset only** — unsupported JSON Schema constructs fail before the child is created; a provider needing a broader schema vocabulary requires a different runtime.
