# dsh-client-ui-agent-preset

English | [中文](README.zh.md)

The agent-preset surfaces: a General-settings row choosing which [preset](../../preset/agent-presets/README.md) new sessions are composed from, a composer seat choosing this session's, and a settings section that authors the compositions themselves.

## Why it is a new-session preference

A session's preset is fixed when the session is created — the host refuses to adopt an existing session under a different one, because that session's history was produced under the first preset's tools. So this row cannot be a live switch, and it says so: changing it applies to sessions started afterwards while running sessions keep the composition they began with.

## The composer seat

A second surface, in the composer tool row left of the model select: the preset THIS session runs. It shows the session's own recorded preset rather than the deployment default, because a resumed session runs what it was created with.

The switch exists only while the conversation has not started. After the first turn the seat becomes a plain label — offering a disabled menu would suggest the choice is merely unavailable rather than gone. The host enforces the same rule and answers `agent-preset-locked`, so a stale client cannot slip a switch past it.

## What it reads and writes

Options and the current default both come from one `agentPreset.list` call. The roster already reports which id a session with no explicit choice gets, so the row needs no settings-schema introspection; the write targets the `agent-presets` settings namespace's `default` field, which is what the host resolves at creation.

A locally authored preset is exactly as privileged as the plugins it names, so the list marks `user` rows rather than presenting every preset as shipped and vetted.

The row re-reads on `settings/changed` for its own namespace and on `connection/reset`: the roster is a live directory and the default is a settings field, so an external edit or a reconnect can both move it.

## The management section

A third surface, its own settings page: the roster as rows, and one composition open in a YAML editor at a time.

A shipped preset opens read-only. It is the known-good composition a local one is written against, so reading it is the point and overwriting it is not — the deployment's copy is what a broken local preset is compared against. Authoring therefore starts by duplicating: **New preset** copies the current default, and **Duplicate** copies any row, because a copy always lands in the local root regardless of where the text came from.

An id becomes a directory name, so the editor mirrors the host's own containment rule (`[a-z0-9][a-z0-9-]*`) and refuses a name already in use — a create landing on an existing name would overwrite a preset the user never opened. Both checks are conveniences: the host re-applies them, along with the composition's shape, and its answer is what the editor reports on failure. A save that parses is still only a save; a composition naming a plugin that does not exist fails at the next session that selects it.

Deleting removes the file. Sessions already composed from it keep running — a composition is mounted once at session creation and nothing re-reads the file.

`agentPreset.read`, `write`, `remove`, and `select` are loopback-pinned ([`dsh-client-connection`](../connection/README.md)): a composition names the plugins a session runs, so reading one is reconnaissance and writing one is arbitrary capability. `agentPreset.list` is not — it carries ids and trust, and a LAN client's picker needs it.

## When the surfaces are absent

A deployment that composes no presets answers with an empty roster, and the row, the seat, and the section all render nothing — every session then shares the host composition, and there is nothing to choose between or manage. A deployment that configures no writable root answers `authorable: false`, and the section stays a read-only browser: the rows still open, but creating is offered nowhere rather than through a button whose save always fails.

## Model Experience

Indirectly, through the preset a later session is composed from; [`dsh-agent-presets`](../../preset/agent-presets/README.md) owns what that composition puts in front of the model.

#### KV Cache effect

No direct invalidation. Changing the default never touches a running session's prefix; a session created afterwards establishes its own prefix from its own composition.

## Known Limitations and Deferred Work

- **Presets are listed by id** — a preset carries no display metadata, so the menus and rows show directory names.
- **The editor is a plain textarea** — no YAML syntax highlighting, folding, or schema completion; the host's shape check on save is the only validation.
- **A saved composition is not mounted** — a preset that parses but names a missing plugin is accepted, and fails at the next session that selects it.
