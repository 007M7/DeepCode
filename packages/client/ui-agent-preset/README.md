# dsh-client-ui-agent-preset

English | [中文](README.zh.md)

The agent-preset surface: one General-settings row choosing which [preset](../../preset/agent-presets/README.md) new sessions are composed from.

## Why it is a new-session preference

A session's preset is fixed when the session is created — the host refuses to adopt an existing session under a different one, because that session's history was produced under the first preset's tools. So this row cannot be a live switch, and it says so: changing it applies to sessions started afterwards while running sessions keep the composition they began with.

## The composer seat

A second surface, in the composer tool row left of the model select: the preset THIS session runs. It shows the session's own recorded preset rather than the deployment default, because a resumed session runs what it was created with.

The switch exists only while the conversation has not started. After the first turn the seat becomes a plain label — offering a disabled menu would suggest the choice is merely unavailable rather than gone. The host enforces the same rule and answers `agent-preset-locked`, so a stale client cannot slip a switch past it.

## What it reads and writes

Options and the current default both come from one `agentPreset.list` call. The roster already reports which id a session with no explicit choice gets, so the row needs no settings-schema introspection; the write targets the `agent-presets` settings namespace's `default` field, which is what the host resolves at creation.

A locally authored preset is exactly as privileged as the plugins it names, so the list marks `user` rows rather than presenting every preset as shipped and vetted.

The row re-reads on `settings/changed` for its own namespace and on `connection/reset`: the roster is a live directory and the default is a settings field, so an external edit or a reconnect can both move it.

## When the row is absent

A deployment that composes no presets answers with an empty roster, and the row renders nothing — every session then shares the host composition, and there is nothing to choose between.

## Model Experience

Indirectly, through the preset a later session is composed from; [`dsh-agent-presets`](../../preset/agent-presets/README.md) owns what that composition puts in front of the model.

#### KV Cache effect

No direct invalidation. Changing the default never touches a running session's prefix; a session created afterwards establishes its own prefix from its own composition.

## Known Limitations and Deferred Work

- **Presets are listed by id** — a preset carries no display metadata, so the menu shows directory names.
- **No authoring** — creating, editing, or deleting a preset is a filesystem act; this surface only chooses among what the roster supplies.
