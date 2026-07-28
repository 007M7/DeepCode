# Agent Note: Independent model and user skill invocation policy

Status: implemented

English | [中文](2026-07-28-skill-invocation-policy.zh.md)

## Problem

The skill registry originally treated discovery as a model catalog: `ctx.skills.list()` removed model-disabled skills, while `ctx.skills.get()` remained an unfiltered trusted loader. That was enough for model-initiated loading, but it could not represent Claude-compatible skills that are advertised only to a person, only to a model, to both, or to neither. The TUI compounded the mismatch by deriving user autocomplete from the model-filtered list and allowing every exact name through `get()`.

The local parser also exposed an internal camel-case spelling as frontmatter. Supporting the established negative `disable-model-invocation` and positive `user-invocable` fields requires a durable, symmetric domain representation without turning every possible YAML key into an untyped cross-package contract.

## Decision

`SkillSummary` carries an optional typed `invocation: SkillInvocationPolicy` object. When present, its `modelInvocable: boolean` and `userInvocable: boolean` fields are both required, positive, and symmetric; future frontmatter keys remain outside the domain model until a consumer and enforcement contract exist. The local provider still parses frontmatter as an open `Record<string, unknown>`, then projects only recognized fields and their defaults into the normalized typed policy.

`ctx.skills.list()` returns every winning summary and no longer chooses an invocation surface. `isModelInvocable(skill)` and `isUserInvocable(skill)` read the matching positive field; an absent policy permits both surfaces. `ctx.skills.get()` remains policy-neutral because trusted internal callers may need any definition, while a public consumer must enforce its own predicate before advertising or loading a skill.

The local provider accepts the exact kebab-case frontmatter keys `disable-model-invocation` and `user-invocable`. It accepts YAML booleans plus case-insensitive `true`/`false`, `yes`/`no`, `on`/`off`, and `1`/`0`, matching the practical boolean forms accepted by Claude skills. It maps `disable-model-invocation` to the inverse positive field and fills the other field's default whenever either key is present. Camel-case external spellings are rejected with a targeted warning; this pre-release repository does not keep an on-disk compatibility alias.

The model-facing `dsh-tool-skill` catalog and loader enforce `isModelInvocable`. The TUI `/skill:` autocomplete and exact loader enforce the user field locally, so a user-only skill is visible and loadable there even when it is absent from model discovery, without turning the optional skill peer into a runtime import. The browser `skill.list` RPC serves a user-selected reference that still asks the model to load the skill, so it exposes the intersection of model- and user-invocable skills; no direct browser skill-loading RPC is added.

These rules permit all four combinations:

| Policy | Model surface | User surface |
|---|---|---|
| no policy, or `{ modelInvocable: true, userInvocable: true }` | included | included |
| `{ modelInvocable: true, userInvocable: false }` | included | excluded |
| `{ modelInvocable: false, userInvocable: true }` | excluded | included |
| `{ modelInvocable: false, userInvocable: false }` | excluded | excluded |

This decision extends the [skill system](2026-07-05-skill-system.md) and supersedes the invocation-policy limitation recorded by the [TUI skill slash command](2026-07-21-tui-skill-slash-command.md).

## Alternatives considered

**Store all frontmatter in a generic `Map` and read string keys in `isModelInvocable` / `isUserInvocable`.** Rejected because misspelled keys, non-boolean values, and consumer-specific coercion would cross package seams without type checking. The parser boundary remains open; the domain model is deliberately typed and narrow.

**Keep `ctx.skills.list()` model-filtered and add a second user list.** Rejected because discovery, duplicate resolution, caching, and ordering are surface-neutral work. One complete catalog plus explicit predicates prevents those mechanisms from drifting while making each consumer's policy visible at its boundary.

**Enforce invocation policy inside `ctx.skills.get()`.** Rejected because `get()` cannot know whether its caller is a model tool, a human command, or trusted orchestration. Filtering there would also make the both-disabled quadrant impossible to inspect or administer.

**Treat camel-case frontmatter as an alias.** Rejected because the external format is the kebab-case Claude skills contract and the repository has no released compatibility obligation. Failing loud avoids silently preserving a nonstandard spelling.

**Add a browser-side direct skill invocation RPC.** Rejected for this change because the existing browser flow inserts a model reference rather than a loaded instruction body. Its correct policy is therefore the intersection; a direct user-loading surface needs its own wire and logging design.

## Consequences

Providers and runtime registrations expose a small typed invocation contract, while local YAML remains extensible. Every new discovery consumer must consciously choose the model predicate, the user predicate, their intersection, or trusted unfiltered access; forgetting that choice is now review-visible rather than hidden in registry behavior.

The changed model catalog is pinned by the keyless ACP snapshot, which includes a model-only skill and excludes a user-only skill. TUI unit coverage exercises all four policy quadrants, and the real Loader/PTY smoke invokes a user-only local skill through `/skill:`. Registry, local-parser, model-tool, and API-proxy tests cover defaults, supported boolean forms, malformed values, legacy-key rejection, exact-load enforcement, and the browser intersection.
