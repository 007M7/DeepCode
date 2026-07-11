# RFC: Prune unconsumed registry modes

Status: proposed

## Problem

Two registries implement modes that no production registration populates.

The skill service's embedded-runtime subsystem has zero production caller of `ctx.skills.register()`. It adds a reserved `runtime` provider name, a runtime map/rank/source, duplicate policy, a second revision in cache keys, normalization, disposers, and tests alongside the provider seam every shipped skill already uses. `SkillSummary.whenToUse` and candidate/definition `path` are parsed and copied but never read by a production consumer: the model catalog renders name/description, resource loading uses `resourceBase`, and providers own their locator. The deliberately open `metadata` extension point stays.

The agent-scope work generalized system-prompt tool and variable providers to scope-local registration, but every production `systemPrompt.tools()` and `systemPrompt.variable()` registration is global. Scoped assembly executes the merge path each step but finds no scoped tool/variable contribution. Scoped sections and protections are live and stay. Supporting empty scope-local tool/variable layers adds maps plus merge/shadow/cleanup branches for combinations the product never constructs.

## Proposal

Remove `SkillService.register()`, `SkillRegistration`, the runtime pseudo-provider and reserved-name rules, runtime revisions/cache branches, and runtime-only source/rank normalization. Tests that need an embedded skill register a small real provider. Retain `providerRevision` as the in-flight discovery epoch, but key completed catalogs by cwd alone: every provider mutation synchronously clears the cache, and the post-await revision comparison already prevents inserting stale work. Remove `whenToUse`, `SkillCandidate.path`, and `SkillDefinition.path` from the skill contract and local-provider copies while retaining provider locator/root paths; retain `metadata`, `disableModelInvocation`, `source`, `provider`, `locator`, and `resourceBase` as either deliberate extension vocabulary or production-consumed fields.

Keep system-prompt sections/protections scoped, but make tool-schema and variable providers global-only and delete their scoped maps/merge logic. Fail loud if a caller attempts these unsupported scope/mode combinations instead of silently widening them. Keep both global and scoped tool guards: the agent-scope/interception design deliberately defines them as owner-final policy APIs. Amend the skill-system and agent-scope RFCs, READMEs, JSDoc, catalogs, and tests.

## Alternatives considered

**Keep all registry modes for embedders.** Runtime skill registration is convenient, and scoped variables/tool-schema fragments could support per-agent prompt customization. Neither has a shipped owner. A real embedded skill can be a provider; per-agent executable tools already belong in `agent.ctx.tools`; per-agent prompt facts can use scoped sections or context-aware global providers.

## Acceptance criteria

- Skill collection has one provider-backed path, a cwd-only completed-cache key, and a revision epoch only for in-flight invalidation; retained skill fields have a production reader or a recorded deliberate extension contract.
- System-prompt tools/variables have one global path; sections/protections retain their scoped behavior.
- Global and scoped tool guards, native finality, and Code Mode finality behavior remain covered.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

These are compile-visible contractions of two pre-release registries. The fail-loud rule must distinguish an unsupported scoped registration from an ordinary global registration without disturbing Cordis effect cleanup, and skill-local frontmatter parsing must continue to preserve and validate the supported metadata schema.
