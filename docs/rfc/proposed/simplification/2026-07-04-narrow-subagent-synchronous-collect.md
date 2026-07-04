# RFC: Narrow the subagent seam to synchronous collect

Status: proposed

## Problem

The implemented [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md) shipped as a named-provider registry plus a synchronous model-facing consumer, but its public contract still carries several deferred capabilities that no production caller can exercise. `dsh-tool-subagent` builds a `SubagentStartRequest` with only `prompt`, `parent`, optional `signal`, and optional `agentOptions` ([packages/subagent/tool-subagent/src/index.ts](../../../../packages/subagent/tool-subagent/src/index.ts)); it never sends `outputSchema`, `maxDepth`, or `toolFilter`, never reads `SubagentResult.structured`, and never calls `SubagentRun.sendMessage` or `SubagentRun.resume`.

That means the current start-time capability descriptor is mostly a contract between tests and docs. `SubagentCapabilities.outputSchema` and `toolFilter` are advertised false by every production provider, and the support mock is the only backend that exercises structured output. `depthLimit` is more subtle: the in-process providers advertise it and the shared driver can reject `request.maxDepth`, but no production tool request sets `maxDepth`, so the advertised recursion guard is dormant in the product path.

The #138 hook stack made one earlier simplification idea too broad: `subagent/start` and `subagent/end` are now live. `dsh-hooks-claude` listens to `subagent/start` to run a `SubagentStart` hook and inject any returned `additionalContext` into the live child, and listens to `subagent/end` to run `SubagentStop` ([packages/hooks/hooks-claude/src/index.ts](../../../../packages/hooks/hooks-claude/src/index.ts)). Those lifecycle emits should stay. What remains idle is the registry-observation surface around the provider map: `ctx.subagents.getProvider()` and `ctx.subagents.list()` still have declarations, docs, generated-catalog entries, and tests, but no production caller.

The new hook stack also exposes an overreach inside the lifecycle payload. [The subagent observe-enrichment RFC](../../implemented/feature/2026-06-30-subagent-observe-enrich.md) added `lastAssistantMessage` so a hooks bridge could forward the child output to a `SubagentStop` handler, but the current `SubagentStop` payload builder does not read it; it emits only `agent_id`, `agent_type`, and `stop_hook_active`. The field therefore buys a `structuredClone` branch, clone-failure containment, docs, and tests without changing any shipped hook behavior. If `SubagentStop` should carry the final child message, that should be implemented end to end; until then the payload should be honest.

The result is an over-wide first-cut seam: every provider and every doc page has to explain structured output, tool filtering, depth flags, steering, resume, provider enumeration, and final-output lifecycle cloning even though the real model-facing behavior is "start a named child, await its final result, cancel or dispose it," plus observe-only lifecycle emits the Claude hook bridge actually consumes.

## Proposal

Make the subagent seam describe the behavior the harness actually uses today: synchronous collect plus the two live observe-only lifecycle emits.

- Remove `SubagentCapabilities` and the `SubagentProvider.capabilities` field.
- Remove `SubagentStartRequest.outputSchema`, `maxDepth`, and `toolFilter`, along with `SubagentService.assertCapabilities`.
- Remove `SubagentResult.structured`.
- Remove optional runtime methods `SubagentRun.sendMessage` and `SubagentRun.resume`.
- Remove the public `SubagentService.getProvider()` and `SubagentService.list()` helpers; provider lookup stays private to `start(name, request)`.
- Keep `subagent/start` and `subagent/end`, but narrow their payloads to the fields the live bridge can use: `provider`, `id`, and on end `stopReason`. Remove `SubagentRunEndInfo.lastAssistantMessage`, the `structuredClone(result.output)` branch, and the clone-failure tests/docs.
- Remove in-process depth vocabulary that exists only to honor `maxDepth`: `AgentOptions.subagentDepth`, `depthOf`, `SubagentDepthError`, and the child-depth check in `startInProcessRun`.
- Update `dsh-subagent-spawn`, `dsh-subagent-fork`, `dsh-subagent-acp`, `dsh-subagent-mock`, `dsh-tool-subagent`, READMEs, [docs/core-data-structures/subagent.md](../../../core-data-structures/subagent.md), and the generated Cordis catalog to the narrower contract.

After the cut, the provider contract is roughly: `name`, `start(request)`, and a `SubagentRun` with `{ id, result, cancel(), dispose() }`. The start request still carries the load-bearing fields: prompt, parent, optional signal, and optional child agent options. The service still emits `subagent/start` / `subagent/end` around that run because the hook bridge now consumes them.

## Why not keep the dormant guard?

The strongest counterargument is recursion: an in-process child can inherit the subagent tool and spawn again. That is a real product concern, but the current `maxDepth` field does not protect the production tool path because `dsh-tool-subagent` never sends it. A dormant guard reads like a safety property while providing none.

If a hard recursion limit is needed, it should come back as an actually wired product policy, probably owned by `dsh-tool-subagent` config or a tool/filtering policy that every production subagent request passes through. That future implementation should be judged against the then-current product shape, not preserved as an optional per-request field that no caller supplies.

## What we give up

Programmatic callers lose prebuilt hooks for structured subagent output, child tool scoping, live steering, follow-up resume, provider enumeration, and final-output lifecycle telemetry. In an unreleased repo, that is an acceptable contraction: none of those hooks has a production caller, and preserving them makes every provider pay an explanation and test cost for speculative behavior.

The in-process backends also lose the dormant depth bookkeeping. That does not weaken the shipped model-facing behavior because no shipped request uses it today. It makes the missing recursion policy honest.

The Claude bridge would no longer be able to forward a child final message to `SubagentStop` without a later payload change. That is also honest: the current bridge does not forward it now. If that behavior becomes product-owned, reintroduce the field with the bridge payload and snapshot/unit coverage that prove the hook sees it.

## Acceptance criteria

- The public subagent contract contains only the synchronous collect surface: provider registration, `start(name, request)`, `SubagentRun.result`, `cancel`, and `dispose`.
- `rg "outputSchema|structured|maxDepth|toolFilter|sendMessage|resume\\(" packages/subagent packages/support/subagent-mock packages/subagent/tool-subagent docs --glob '!docs/rfc/**'` finds no remaining contract surface except unrelated prose or new historical references.
- `rg "getProvider\\(|ctx\\.subagents\\.list\\(" packages examples docs --glob '!docs/rfc/**'` finds no production API surface.
- `rg "lastAssistantMessage" packages docs --glob '!docs/rfc/**'` finds no live contract, clone branch, test, or generated-catalog entry.
- `subagent/start` and `subagent/end` still exist, and `dsh-hooks-claude` still handles `SubagentStart` / `SubagentStop`.
- The Cordis catalog, core data-structure docs, package READMEs, and type-equivalence manifest are updated.
- Focused subagent tests still prove registration HMR safety, duplicate provider rejection, missing provider rejection, in-process spawn/fork result collection, ACP result collection, abort bridging, and always-dispose behavior.
- `pnpm run test:coverage`, `pnpm run test:snapshot`, `pnpm run doc-sync`, and `pnpm run hygiene` pass after implementation.

## Risks

- A future subagent UI may want richer lifecycle payloads. Keep the live emits now, but reintroduce extra fields only with that UI and a payload it actually consumes.
- A future structured-output subagent may want `outputSchema`. Reintroduce it when a provider and consumer both honor it end to end, including validation semantics and model-facing schema design.
- A future recursion limit may be necessary. The replacement should be wired through the production subagent tool path instead of relying on an optional field the tool never sets.
