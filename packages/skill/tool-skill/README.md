# @deepseek-ai/dsh-tool-skill

English | [中文](README.zh.md)

The model-facing skill catalog and `skill` tool.

Requires `ctx.tools` and `ctx.skills` (`inject: ['tools', 'skills']`).

## Session-prefix catalog

The plugin contributes one user-role `<system-reminder>` catalog through `agent/session-prefix`. It resolves skills for the calling session's cwd, forwards the prefix abort signal to discovery, and lists only sorted `name` and `description` entries; skill bodies, paths, sources, providers, and `whenToUse` hints remain outside the catalog. The catalog is omitted when no model-invocable skills are available, and also when that agent's tool view restricts away the shipped `skill` tool or resolves a same-name scoped shadow instead. This exact-definition check keeps prompt guidance, the model-visible schema, and executable dispatch aligned.

`catalogDescriptionMaxLength` controls normalized, XML-escaped catalog descriptions. Its default is `500` and values must be integers of at least `3`, which reserves room for a truncation ellipsis. The [session-prefix Agent Note](../../../.agents/notes/implemented/feature/2026-07-07-session-prefix.md) defines the request-only, header-logged lifecycle of this message.

## Tool: `skill`

| Arg | Type | Notes |
|---|---|---|
| `name` | string (required) | Exact kebab-case skill name from the available skills listing. |

Execution uses the calling agent's `session.header.cwd` so workspace-sensitive providers resolve the winning skill. A successful call returns canonical `{ name, provider, resourceBase?, content }`, excluding catalog ranking and provider-internal machinery; its Native renderer produces one text result containing `<skill_content name="...">`, `<skill_resources>`, and `<skill_instructions>`.

Resource guidance resolves only paths or URLs explicitly referenced by the instructions against `resourceBase`; scripts, references, and assets load on demand, and the result does not enumerate a skill directory. Local providers may supply a directory, while remote or embedded providers may supply a URL or opaque loading guidance.

An unresolved name reports that the skill is unknown or no longer available. Invalid names and `disableModelInvocation: true` skills produce distinct error results.

The tool does not call `agent.inject()` in v1. Its result is already recorded as the tool result and becomes available to the next model step without duplicating the content as synthetic context.

## Model Experience

### Session prefix

#### What the model sees

If model-invocable skills exist and this exact `skill` tool is visible, the agent receives the catalog template below, with one data-dependent entry per sorted skill. The catalog is a frozen user-role session prefix.

##### Skill catalog template

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
</system-reminder>
```

#### Token effect

Repeated input cost scales with skill count and `catalogDescriptionMaxLength`; no catalog tokens are sent when the list is empty or the tool is hidden or shadowed.

#### KV Cache effect

Prefix-stable within a loop instance once the session prefix is composed. A new or resumed instance with different providers, skills, descriptions, visibility, or catalog limits may invalidate reuse from the first changed catalog token.

### Tool schema

#### What the model sees

The model sees the generated [`skill` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill).

#### Token effect

Fixed schema cost per request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged. Shadowing, restrictions, or plugin lifecycle changes may invalidate reuse from this schema.

### Tool result

#### What the model sees

A successful call uses the result template and the provider-managed, directory, URL, or opaque resource guidance below.

##### Skill result template

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### Provider-managed resource guidance

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### Directory resource guidance

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL resource guidance

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### Opaque resource guidance

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token effect

Loaded instructions are data-dependent tool-result tokens, resent on later steps until compaction; no duplicate `agent.inject()` copy is made.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Invalid or stale selections return exactly `Error: invalid skill name "<name>"`, `Error: skill "<name>" is unknown or no longer available`, or `Error: skill "<name>" is not available for model invocation`. Provider-thrown lookup text is data-dependent and receives the same `Error: <message>` wrapper.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The catalog omits `whenToUse`, source, and provider metadata** — routing is based only on name and a capped description; `whenToUse` remains provider metadata and is not rendered by the loaded wrapper either.
- **Loaded instruction bodies have no size cap** — a provider can return a skill large enough to consume substantial next-step context; only catalog descriptions are truncated.
- **Resources are guidance, not attachments** — the tool reports a base directory/URL/opaque hint but neither enumerates nor fetches referenced files for the model.
- **Loading is one-shot text** — there is no partial, streaming, or cached-content handle when a remote provider is slow or a skill body is large.
