# dsh-client-ui-agent-preset

English | [中文](README.zh.md)

The agent-preset surfaces: a General-settings row choosing which [preset](../../preset/agent-presets/README.md) new sessions are composed from, a chip on the new-session screen choosing the next session's, a read-only label in the session header, and a settings section that authors the compositions themselves.

## Why it is a new-session preference

A session's preset is fixed when the session is created — the host refuses to adopt an existing session under a different one, because that session's history was produced under the first preset's tools. So this row cannot be a live switch, and it says so: changing it applies to sessions started afterwards while running sessions keep the composition they began with.

## The new-session chip

A second surface, beside the workspace picker on the new-session screen. It sits there rather than in the composer because that is where the choice is still open: a control that spends most of its life disabled belongs on the screen where it still works.

The chip opens on the deployment default and its pick is *staged* — the screen precedes the session it would apply to. The stage reaches a session when one becomes current and is still blank, which covers both the session the workspace connect created and the blank one it reused; riding along on `sessions.create` would miss the second. It is spent on first use, so the next new session opens on the default again, exactly like the workspace picker beside it.

A session that has started is refused rather than queued: the host answers `agent-preset-locked`, and the stage is dropped instead of waiting for a session that will never accept it.

## The session-header label

A third surface, beside the session title: the preset THIS session runs, as static chrome. A control there would promise a switch the host refuses outright. It reads the preset from the session's own summary — a resumed session runs what it was created with, not today's default — and resolves the display name against the same roster the General row reads.

## What it reads and writes

Options and the current default both come from one `agentPreset.list` call. The roster already reports which id a session with no explicit choice gets, so the row needs no settings-schema introspection; the write targets the `agent-presets` settings namespace's `default` field, which is what the host resolves at creation.

A locally authored preset is exactly as privileged as the plugins it names, so the list marks `user` rows rather than presenting every preset as shipped and vetted.

The row re-reads on `settings/changed` for its own namespace and on `connection/reset`: the roster is a live directory and the default is a settings field, so an external edit or a reconnect can both move it.

## The management section

A fourth surface, its own settings page (`settings.section` id `agent-presets`, ordered after Models — choosing a model is routine, composing an agent is the deployment-shaping act behind it): the roster as rows, and one composition open in a YAML editor at a time.

A shipped preset opens read-only. It is the known-good composition a local one is written against, so reading it is the point and overwriting it is not — the deployment's copy is what a broken local preset is compared against. **Duplicate** copies any row, because a copy always lands in the local root regardless of where the text came from; **New preset** starts blank, since copying is already offered on the row being copied and a composition nobody named is text the author has to recognise as unwanted before deleting it.

An id becomes a directory name, so the editor mirrors the host's own containment rule (`[a-z0-9][a-z0-9-]*`) and refuses a name already in use — a create landing on an existing name would overwrite a preset the user never opened. Both checks are conveniences: the host re-applies them, along with the composition's shape, and its answer is what the editor reports on failure. A save that parses is still only a save; a composition naming a plugin that does not exist fails at the next session that selects it.

Deleting removes the file. Sessions already composed from it keep running — a composition is mounted once at session creation and nothing re-reads the file.

Setting the default writes the `agent-presets` settings namespace, which the host exposes to configuration clients ([`dsh-apiproxy`](../../host/apiproxy/README.md) keeps an explicit allowlist — a namespace outside it makes a picker move and then silently forget).

`agentPreset.read`, `write`, `remove`, and `select` are loopback-pinned ([`dsh-client-connection`](../connection/README.md)): a composition names the plugins a session runs, so reading one is reconnaissance and writing one is arbitrary capability. `agentPreset.list` is not — it carries ids and trust, and a LAN client's picker needs it.

## When the surfaces are absent

A deployment that composes no presets answers with an empty roster, and the row, the chip, the label, and the section all render nothing — every session then shares the host composition, and there is nothing to choose between or manage. A deployment that configures no writable root answers `authorable: false`, and the section stays a read-only browser: the rows still open, but creating is offered nowhere rather than through a button whose save always fails.

## Model Experience

Indirectly, through the preset a later session is composed from; [`dsh-agent-presets`](../../preset/agent-presets/README.md) owns what that composition puts in front of the model.

#### KV Cache effect

No direct invalidation. Changing the default never touches a running session's prefix; a session created afterwards establishes its own prefix from its own composition.

## Known Limitations and Deferred Work

- **A preset without metadata is listed by id** — display text is optional, and a preset that publishes none (every preset authored by duplicating another starts that way) shows its directory name.
- **The editor is a plain textarea** — no YAML syntax highlighting, folding, or schema completion; the host's shape check on save is the only validation.
- **A saved composition is not mounted** — a preset that parses but names a missing plugin is accepted, and fails at the next session that selects it.
