# RFC: Prune dead public and result surface

Status: proposed

## Problem

Several package-root exports, result fields, and convenience methods have no production consumer. They survive because tests import internals through public entry points or because a type anticipated a caller that never arrived. Each item is small in isolation, but together they enlarge the SDK contract, generated catalogs, documentation, and regression matrix without enabling a shipped path.

The production corpus is `packages/*/*/src`, example sources/config, and runtime scripts; tests, package READMEs, generated catalogs, and RFC prose are evidence of publication but not consumers. Exact-symbol searches produce the following inventory:

| Surface | Production evidence | Simplification |
| --- | --- | --- |
| `SurfaceManager.invalidate()` | Only its unit test calls it; seeding completes before the lazily-created manager exists and the session never replaces its log reference. | Delete it and its impossible wholesale-replacement contract. |
| `ToolExecutionResult.callId` | Every hook already receives the immutable `ToolExecution`; the loop and ACP correlate through the call/session event. No consumer reads the duplicate result field. | Remove the field, copy/mismatch guards, and tests that prove the duplicate cannot disagree. |
| `ReactLoopAgent` root export | Outside-package named imports are tests; production programs against `Agent` and creates/resumes through `ctx.agents`. | Return/interface-type `Agent` and make the concrete loop class package-internal; keep the deliberate synchronous config-only `AgentLoop.create()` path. |
| `workflow-workerthread` protocol/runtime/session re-exports and named `WorkerWorkflowEngine` | Every package-name consumer uses the default engine; the workflow RFC already defines the worker wire protocol as private. | Keep the default plugin class/config contract; drop the duplicate named class export and keep protocol modules source-private. |
| `code-runtime-worker` protocol/bootstrap re-exports | Outside-package production/e2e consumers use `WorkerCodeRuntime` and config, not `BootstrapPort`, `PatchableStream`, or worker message/boot types. | Keep the runtime class/config contract and make its wire/bootstrap vocabulary source-private. |
| `providerWording` and `completedTurnPrefix` root exports | Each has one same-package production caller; only the balanced-prefix helper has a same-package white-box test. | Make them source-private and test provider behavior. |
| `depthOf`, `SubagentDepthError`, `SENSITIVE_ENV_PATTERN`, `waitForExit`, and `exitsWithin` root exports | Production subagent backends consume the in-process runner and subprocess construction/disposal helpers, not these enforcement/test internals. | Keep depth/environment/exit behavior but make the helpers and error/regex source-private; test through spawn and disposal. |
| `PersistenceCoordinator.inits`, backend `inits` accessors, `seedCoversPrefix`, and `assertSerializable` | The accessors exist for white-box tests; the helpers have no outside production importer. | Observe initialization through `session/flush` and internalize the helpers. Keep both backends, `SessionHeader`, and SQLite's version contract. |
| `LlmService.models()` | Tests/docs only; production resolves a configured adapter directly. | Delete the convenience while keeping both LLM adapters. |
| `LlmError.status` and replay status | Adapters/replay populate it, but production branches on stable error code/message and never reads raw status. | Remove the unread field and replay plumbing while preserving error classification. |
| `BlockAssembler.push()` return value | Both production callers ignore the returned completed block. | Return `void`; keep the deliberately public `blocks()`/`message()` contract. |
| `compactRegion`'s separate `session` argument | The sole production caller passes the same object already present as `agent.session`; the API permits an incoherent pair. | Use `agent.session` as the one source of truth. |
| `CompactionResult.startSeq`, `summarySeq`, `endSeq`, and `summary` | The production consumer reads only shadowed range/seq/token accounting; the durable log owns summary and event identity. | Remove the four result echoes while keeping both shared transcript renderers. |
| `BasicCompactService` estimation/summarization visibility | No outside production caller invokes the five methods; the implemented RFC names only `estimateContentTokens()` and `summarize()` as subclass hooks. | Make those two `protected` and the three orchestration-only estimators private. |
| `CodeLogEntry.source`/`level` and `RunCodeMeta.dispatches` | Every production consumer maps logs to text; no presenter/model path reads the other fields or the persisted dispatch count. | Make code-runtime logs strings (or text-only entries) and remove result-meta dispatch plumbing; keep the local counter that mints deterministic dispatch ids. |
| `ToolNotFoundError.toolName`, `SystemPrompt.config`, and `BashTask.command` | Each stored public value has no production reader. | Drop the unread field while retaining error messages, resolved configuration behavior, and task lifecycle. |

## Proposal

Remove or demote every row as one bounded coordinated public-surface cleanup. Update package READMEs, JSDoc, generated API/event catalogs, type-equivalence records, exports maps where needed, and tests so they exercise the owning public seam instead of preserving test-only entry points. Do not collapse any capability seam, LLM adapter, persistence backend, or lifecycle quiescence contract.

## Alternatives considered

**Keep test conveniences and self-contained results public.** Public helpers can make white-box tests convenient, self-contained result fields can look ergonomic, and future embedders might want the concrete loop or enumeration methods. Those benefits are hypothetical; today they make every implementation and document explain states that no shipped caller can observe. A real consumer can introduce the smallest contract it needs, with its ownership and failure semantics known.

## Acceptance criteria

- Exact-symbol searches show no removed surface outside this RFC and any implemented-RFC amendments.
- Every surface listed in this RFC is absent or demoted as specified; deliberately retained extension/test contracts outside the inventory are unchanged.
- Tool execution, compaction, both LLM adapters, both persistence backends, workflow isolation, and agent creation/resume retain their shipped behavior.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

Most removals are compile-visible but runtime-neutral. The compaction argument cleanup deliberately forbids a session/context mismatch that no caller uses; the remaining changes can require external pre-release embedders to import less or adjust result shapes. The repository is unreleased, so carrying unsupported surface is the larger foundation cost.
