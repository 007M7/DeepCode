# Skill system — progressive disclosure instructions for agents

## Status

Implemented.

## Context

Agent products have converged on a skill pattern: keep the request prompt small by listing only available instruction bundles, then load the full body when the model decides a task matches. Codex, Claude Code, OpenCode, and Kimi Code differ in details, but all separate discovery metadata from complete instructions so a workspace can carry reusable behavior without paying the full prompt cost on every turn.

DeepSeek Harness needs the same primitive because project-specific review, plugin-authoring, and tool-usage guidance should live next to the workspace or the user's agent configuration instead of being hard-coded into the loop. The repo is still unreleased, so this change establishes the foundation directly as first-class packages rather than a compatibility layer around an older format.

## Decision

Add `@deepseek-ai/dsh-skill` as the discovery service (`ctx.skills`) and `@deepseek-ai/dsh-tool-skill` as the model-facing loader tool. `dsh-agent-core` loads both by default so stdio and ACP apps get the same behavior.

Discovery scans cwd-sensitive project roots, runtime registrations, user roots, extra roots, and system roots in first-wins priority order: project `.dsh`, project `.agents`, runtime, user `.dsh`, user `.agents`, extra roots, then `~/.dsh/skills/.system`. The user `.dsh/skills` scan skips `.system` so built-ins are not discovered twice. Same-name lower-priority skills are ignored with a warning, which lets project and user skills override built-ins deliberately.

Each skill is either `<name>/SKILL.md` or `<name>.md` with YAML frontmatter. `name` and `description` are required; `whenToUse`, `disableModelInvocation`, and `metadata` are optional. Names are kebab-case. YAML frontmatter is parsed with the `yaml` package instead of a hand-written parser because the format already exposes an open `metadata` object and should behave like ordinary skill files rather than a bespoke key/value subset.

The service injects a request-time `## Skills` fragment through the existing `agent/request` waterfall. It appends to `GenerateOptions.system` instead of changing `systemPrompt.assemble()`, because the available project skills depend on the calling agent's cwd. The fragment contains only stable routing metadata and is sorted by skill name after first-wins collection, so equivalent workspaces produce deterministic prompt text and better prefix-cache reuse. Full skill bodies are never included in the listing.

The `skill({ name })` tool loads one full skill for the current agent cwd and returns a `<skill_content name="...">` block with the body plus base-directory guidance. Invalid names, unknown skills, and skills marked `disableModelInvocation` return tool errors. v1 does not additionally inject the loaded body into session context; the tool result is the model-visible disclosure path.

System skills are ordinary skill files materialized under `~/.dsh/skills/.system` on startup. v1 ships `dsh-plugin-creator` and `dsh-skill-creator` there so the agent can help author DeepSeek Harness plugins and future skills using the same mechanism users can override.

The data structures and prompt/tool contract are documented in [skills.md](../../../core-data-structures/skills.md), with service signatures in the generated [services catalog](../../../cordis-catalog/services.md).

## Rejected alternatives

**Inject full skill bodies into every system prompt.** Rejected because it destroys progressive disclosure and makes every request pay for instructions that may not apply.

**Expose skills only as slash commands.** Rejected for v1 because model-initiated loading is the core capability; slash/ACP command advertisement can layer on later without changing discovery.

**Use a separate system-reminder message.** Rejected for the current loop because `agent/request` already owns the last mutation point before the adapter call and `GenerateOptions.system` is the provider-neutral system prompt surface. A later provider-specific surface can still split this fragment if needed.

**Recursively discover nested `**/SKILL.md`.** Rejected for v1. Flat files and one-level directory bundles cover the configured roots while keeping duplicate handling and prompt order easy to reason about.

**Hand-parse frontmatter.** Rejected because the accepted schema includes an open `metadata` object. A narrow parser would either reject valid YAML users expect to work or grow into an unreviewed YAML subset.

## Consequences

The agent-core spine now includes one more request-time contributor and one more model-facing tool. Skill discovery is cwd-sensitive, so tests and callers that create agents with different session cwd values can observe different project skill overrides by design.

The prompt fragment is deterministic for a fixed root set and runtime registration revision, but disk changes are not watched; discovery is memoized until runtime registration invalidates the cache or the process restarts. That keeps v1 simple and avoids adding file watching policy before there is a concrete user flow for hot-reloading skills.
