# @deepseek-ai/dsh-tool-skill

The model-facing skill catalog and `skill` tool.

Requires `ctx.tools` and `ctx.skills` (`inject: ['tools', 'skills']`).

## Session-prefix catalog

The plugin contributes one user-role `<system-reminder>` catalog through `agent/session-prefix`. It resolves skills for the calling session's cwd, forwards the prefix abort signal to discovery, and lists only sorted `name` and `description` entries; skill bodies, paths, sources, providers, and `whenToUse` hints remain outside the catalog. The catalog is omitted when no model-invocable skills are available.

`catalogDescriptionMaxLength` controls normalized, XML-escaped catalog descriptions. Its default is `500` and values must be integers of at least `3`, which reserves room for a truncation ellipsis. The [session-prefix RFC](../../../docs/rfc/implemented/feature/2026-07-07-session-prefix.md) defines the request-only, header-logged lifecycle of this message.

## Tool: `skill`

| Arg | Type | Notes |
|---|---|---|
| `name` | string (required) | Exact kebab-case skill name from the available skills listing. |

Execution uses the calling agent's `session.header.cwd` so workspace-sensitive providers can resolve the right winning skill. A successful call returns one text tool result with `<skill_content name="...">`, containing `<skill_resources>` followed by `<skill_instructions>`. Resource guidance resolves paths or URLs explicitly referenced by the loaded instructions against `resourceBase`; referenced scripts, references, and assets load only when needed, and the tool does not enumerate a skill directory. Local filesystem skills provide a base directory, while remote or embedded providers can provide a URL or opaque provider-managed guidance. A name that cannot be resolved reports that the skill is unknown or no longer available; invalid names and skills marked `disableModelInvocation: true` retain distinct `isError` results.

The tool does not call `agent.inject()` in v1. Its result is already recorded as the tool result and becomes available to the next model step without duplicating the content as synthetic context.
