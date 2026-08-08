# @deepseek-ai/dsh-client-ui-skill

English | [中文](README.zh.md)

Skill invocation source, browser half: registers the `/`-trigger `skill` source into `ctx.slash`. Ordinary-session candidates come from the `skill.list` RPC addressed by the per-call `ClientSessionContext` projection's `{sessionId}`, with the host resolving `cwd` from the session header. The host serves every user-invocable skill; a `modelInvocable: false` entry (a `disable-model-invocation` skill, whose only entry point is this path) wears the user-only marker as a description prefix in the active language. Catalog-addressed continuable children resolve no skill candidates locally because the existing skill RPC requires an attached session; viewing their persisted history must not activate them. Catalogs cache per ordinary session with a single-flight fetch; the scope-birth `warm` hook prewarms the session's entry and `connection/reset` clears everything. Results filter by `startsWith(query)`.

A menu pick or an entered `/name [args]` line claims the composer into an args-tolerant `skill.invoke` transaction (`matchEnter` strong-waits the catalog; an unknown name answers undefined and stays a plain prompt). A skill name shared with a host command resolves to the command: adjudication polls sources in registration order and the web bundle mounts ui-command ahead of this source — deliberate precedence, matching peer products. Submit trims the args, keeps blank args off the wire, and folds an RPC refusal into the composer's error outcome; the host renders the skill body and injects it as a user message before starting the turn, so invocation is deterministic for every user-invocable skill. The RPC rides the plugin's root-context connection captured at registration — the source never reads services off a per-call argument. Draft chip visuals still derive from the `lexicon` scan; the legacy `<skill>name</skill>` reference codec is gone (decision 21 removal cut) and `matchSpace` stays unimplemented — menu and enter own the skill flows.

A failed `skill.list` throws from `candidates`, which the slash shell logs and folds into a silent menu-group drop — the menu shows only pending/ready states.

The `/client` export surface is the plugin body (`apply`/`inject`) only; the source object is internal to the registration effect.

## Skill tool row

The browser plugin also registers a keyed `skill` toolview in `conversation.chat.toolview`. A collapsed row renders the 14-pixel skill document-and-sparkle glyph, `Skill` title, separator, and requested skill name with the same neutral hierarchy as the Bash row; running calls carry the transcript shimmer, failures replace the name with the first error line, and interrupted calls use the warning state. A settled row expands as one whole-row disclosure into a bounded `Instructions` card containing the exact durable tool output, with the standard trajectory `Inspect` affordance when available. The row derives its name, lifecycle, and body only from a paired call/result slice in the current runtime window, never from the current catalog, so replay remains stable when installed skills or their descriptions change.

## Model Experience

### User-explicit skill invocation

#### What the model sees

A claimed invocation never ships the `/name` literal. The host (`skill.invoke`) renders the canonical `<skill_content>` block — the same `renderSkillContent` output the `skill` tool returns — appends the user's trailing text after a blank line, and injects the whole as one user-role message carrying the `skill-invocation` source, immediately starting a turn. Loading is deterministic: the model receives the full body without being asked to call the `skill` tool, and the catalog (rendered by `dsh-tool-skill`) tells it not to re-load an inline-injected skill.

#### Token effect

One invocation adds the rendered skill body plus the trailing text to that turn's user message — the same cost as the model loading the skill through the tool, paid unconditionally instead of at the model's discretion. Menu browsing and the candidate fetch add zero model tokens.

#### KV Cache effect

Append-only: the injected message lands after the reusable history prefix. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

- **Result-only history pages use the generic row** — keyed dispatch needs the paired call in the runtime window; pagination that leaves the call outside has no tool identity. This client presentation feature does not extend the history wire contract to recover it.
- **Enter waits on the catalog once** — `matchEnter` strong-waits the session's first catalog fetch before answering, so an enter racing a cold cache resolves against the settled catalog rather than silently missing. A menu opened before the prewarm settles still shows no skill candidates for that keystroke.
- **Text is the truth** — the reference is plain draft text; a hand-typed identical token is the same reference. Chip visuals derive from the lexicon scan; no occurrence identity or position tracking (componentized chips are a ledger item).
