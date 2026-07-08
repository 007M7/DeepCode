# RFC: Skill system — progressive disclosure instructions for agents

Status: implemented

## Problem

Agent products have converged on a skill pattern: keep the request prompt small by listing only available instruction bundles, then load the full body when the model decides a task matches. Codex, Claude Code, OpenCode, and Kimi Code differ in details, but all separate discovery metadata from complete instructions so a workspace can carry reusable behavior without paying the full prompt cost on every turn.

DeepSeek Harness needs the same primitive because project-specific review, plugin-authoring, and tool-usage guidance should live next to the workspace or the user's agent configuration instead of being hard-coded into the loop. The repo is still unreleased, so this change establishes the foundation directly as first-class packages rather than a compatibility layer around an older format.

## Decision

Add `@deepseek-ai/dsh-skill` as the provider registry (`ctx.skills`), `@deepseek-ai/dsh-skill-local` as the shipped local filesystem provider, and `@deepseek-ai/dsh-tool-skill` as the model-facing loader tool. `dsh-agent-core` loads the registry, local provider, and tool by default so stdio and ACP apps get the same behavior while future providers can contribute embedded or remote skills without changing the registry or tool.

Provider catalogs return ranked candidates. The registry validates each candidate, resolves same-name skills first-wins by rank, provider registration order, and provider-local order, then sorts model-visible summaries by skill name for deterministic prompt text. Runtime `ctx.skills.register(...)` remains a convenience for embedded in-process skills and uses project-over-user priority; `runtime` is reserved as the registry-owned provider name.

The local provider scans cwd-sensitive project roots, custom roots, and user roots in first-wins rank order: project `.dsh`, project `.agents`, `customSkillDirs`, user `.dsh`, then user `.agents`. The user `.dsh/skills` scan skips `.system` so a system-owned directory is not treated as normal user content. DeepSeek Harness does not ship built-in system skills in v1; plugin-authoring skills can be supplied later by another provider.

Each skill is either `<name>/SKILL.md` or `<name>.md` with YAML frontmatter. `name` and `description` are required; `whenToUse`, `disableModelInvocation`, and `metadata` are optional. Names are kebab-case. YAML frontmatter is parsed with the `yaml` package instead of `js-yaml` or a hand-written parser: `yaml` is the already-declared modern parser for this package's limited frontmatter needs, and a narrow parser would either reject valid YAML users expect to work or grow into an unreviewed YAML subset.

Local skill filesystem I/O goes through `ctx.fs` when a filesystem service is loaded: project-root lookup probes `.git` with `resolve` and `stat`, root discovery uses `listDir`, and skill reads use `readText`. The Node filesystem remains a fallback for minimal contexts that mount `dsh-skill-local` without the fs seam. Missing roots, unreadable or malformed skill files, and transient provider `list()` failures degrade to warn-and-skip so one bad source does not make every agent request fail; malformed candidates still fail fast because they are provider contract violations.

The service injects a request-time `## Skills` fragment through the existing `system-prompt/assemble` waterfall. It appends a late section for the calling agent instead of mutating `GenerateOptions.system` in `agent/request`, because request configuration is now reconstructable model/sampling state while model-visible content flows through system prompt assembly. The fragment contains only stable routing metadata, splits `{{` / `}}` before template rendering, and is sorted by skill name after first-wins collection, so equivalent workspaces produce deterministic prompt text and better prefix-cache reuse. Full skill bodies are never included in the listing.

The `skill({ name })` tool loads one full skill for the current agent cwd and returns a `<skill_content name="...">` block with the body plus provider resource guidance. Local filesystem skills include base-directory guidance; embedded or remote providers can return URL or opaque provider-managed guidance. Invalid names, unknown skills, and skills marked `disableModelInvocation` return tool errors. v1 does not additionally inject the loaded body into session context; the tool result is the model-visible disclosure path.

The data structures and prompt/tool contract are documented in [skills.md](../../../core-data-structures/skills.md), with service signatures in the generated [services catalog](../../../cordis-catalog/services.md).

## Alternatives considered

**Inject full skill bodies into every system prompt.** Rejected because it destroys progressive disclosure and makes every request pay for instructions that may not apply.

**Expose skills only as slash commands.** Rejected for v1 because model-initiated loading is the core capability; slash/ACP command advertisement can layer on later without changing discovery.

**Put local filesystem scanning directly inside `ctx.skills`.** Rejected because coding agents, web agents, and future plugin ecosystems need different skill sources. A provider registry mirrors the subagent seam: the registry owns conflict resolution and consumers, while implementations own loading.

**Use a separate system-reminder message.** Rejected for the current loop because the provider-neutral system prompt surface is assembled through `system-prompt/assemble`. A later provider-specific surface can still split this fragment if needed.

**Materialize built-in DSH authoring skills under `~/.dsh/skills/.system`.** Rejected for v1 because bundled skills should not write user home on startup, and the product can receive those skills from a later embedded or remote provider.

**Recursively discover nested `**/SKILL.md`.** Rejected for v1. Flat files and one-level directory bundles cover the configured roots while keeping duplicate handling and prompt order easy to reason about.

**Hand-parse frontmatter.** Rejected because the accepted schema includes an open `metadata` object. A narrow parser would either reject valid YAML users expect to work or grow into an unreviewed YAML subset.

## Consequences

The agent-core spine now includes one more request-time contributor, one local provider, and one model-facing tool. Skill discovery is cwd-sensitive, so tests and callers that create agents with different session cwd values can observe different project skill overrides by design.

The prompt fragment is deterministic for a fixed root set and runtime registration revision, but disk changes are not watched; discovery is memoized until runtime registration invalidates the cache or the process restarts. That keeps v1 simple and avoids adding file watching policy before there is a concrete user flow for hot-reloading skills.
