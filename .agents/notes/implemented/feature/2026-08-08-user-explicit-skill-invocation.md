# Agent Note: User-explicit skill invocation over skill.invoke

Status: implemented

English | [中文](2026-08-08-user-explicit-skill-invocation.zh.md)

## Problem

A `disable-model-invocation: true` skill is user-only by design: it never enters the model-facing catalog and the `skill` tool refuses to load it. Its only legitimate entry point is an explicit user gesture — yet the web client had none. `skill.list` filtered to the model-and-user intersection (hiding user-only skills from the menu), an entered `/name` line rode into the default prompt sink as plain text, and the model it reached was forbidden to load the skill — so it degraded to `read`-ing the SKILL.md file or ignoring the gesture (issue #1470). Even for ordinary skills, the decision-21 plain-text reference made user invocation a collaboration cue the model could ignore, not a guarantee.

## Decision

User-explicit invocation is a deterministic host-side injection, uniform for every user-invocable skill:

- `skill.invoke { sessionId, name, text? }` (host apiproxy) enforces user-invocation policy at the operation boundary (`skill-not-found` / `skill-not-invocable`), renders the skill with the shared `renderSkillContent`, appends the optional trailing text after a blank line, and injects the whole as one user-role message carrying the new `skill-invocation` `MessageSource` kind (`{ name, args? }`) before starting a turn through the same route-served gate as `session.prompt`.
- `renderSkillContent` moved from `dsh-tool-skill` to the `dsh-skill` seam: the `skill` tool result and the injection share one verbatim `<skill_content>` shape, and the catalog text gained the seam rule — an inline-injected skill must be followed, not re-loaded through the tool.
- `skill.list` serves every user-invocable skill and carries `modelInvocable`, so the browser menu lists user-only skills with a marker (description prefix — the `hint` field is claim-state ghost text the menu never renders).
- ui-skill claims a menu pick or an entered `/name [args]` into the invoke transaction (`matchEnter` strong-waits the catalog; unknown names stay plain prompts). The unreached legacy `<skill>name</skill>` reference codec is removed.
- The transcript materializes the injection as a dedicated `skill-invocation` node from source metadata (never re-parsed from the body) and renders a right-aligned bubble: `/name` chip, trailing text, and the injected block collapsed behind a disclosure.

Peer-product survey (Pi, OpenCode, Claude Code, Kimi Code, Codex, DeepSeek-Reasonix — local checkouts) was unanimous: user-explicit triggering is programmatic injection as a user-role message with zero model participation on every product, prompt-guided tool loading exists only on the model-autonomous track, and the disable-model-invocation equivalents gate only the model-side surfaces. Kimi's origin-metadata rendering and the Claude Code/Kimi no-reload prompt rule translate directly onto `MessageSource` and the catalog sentence.

## Alternatives considered

- **`agent.inject()` context injection** — no peer precedent; the gesture is a user turn, not an environment notice, and context-row presentation, compaction, and attribution all mismatch. Rejected.
- **A host `/skill <name>` command** (command registry, plan-mode precedent) — two-token UX, no name completion, and user-only skills stay undiscoverable in the menu; the per-cwd skill catalog also fits the static command registry poorly. Rejected.
- **Client-side expansion** (fetch body, splice into the prompt) — authorization becomes bypassable client courtesy, the log loses the invocation semantics, and Codex deleted its equivalent mechanism (custom prompts) in favor of core injection. Rejected.
- **Host prompt-pipeline scanning for `/name`** (Codex `$name` core mentions) — duplicates the adjudication layer and risks swallowing literal slashes in prose; the claim path already covers the need. Rejected.
- **Per-injection preamble line** (Kimi's `User activated the skill …`) — dropped in favor of a one-time catalog sentence: same context, paid once, and the injected block stays byte-identical with the tool result.

## Consequences

- Decision 21's plain-text reference path is superseded at submission: the draft still carries plain text and lexicon-derived chip visuals, but submit claims into a deterministic injection instead of shipping the literal and hoping. The model-autonomous track (catalog + `skill` tool) is unchanged.
- Every user-invocable skill invocation now costs its full rendered body unconditionally — the price of determinism the peer survey showed everyone pays.
- The `skill-invocation` source rides `user/message`, so Model-visible ⟺ logged holds with no new event type, and replay/UI read metadata rather than text markers.
- TUI and ACP can adopt `skill.invoke` later for the same semantics; until then the TUI's client-side expansion remains its own path.
