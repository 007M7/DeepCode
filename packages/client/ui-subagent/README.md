# @deepseek-ai/dsh-client-ui-subagent

English | [中文](README.zh.md)

Subagent reference source, browser half: registers the `@`-trigger `subagent` source into `ctx.slash`. Candidates are zero-RPC — filtered from the root `ctx.sessions.list` snapshot captured at registration (children of the per-call projection's session: `parentId` matches, `running`, `displayTitle` contains the query); picking a candidate lands the literal `@label ` text through the slash pipeline (decision 21 plain-text reference), and the source `codec` projects both faces as `@label` — the model serialization stays the raw label until the `@` consumption feature defines a model representation. The source implements no `matchSpace`/`matchEnter` hooks — subagent references never enter command adjudication and ride ordinary prompts into the default sink.

A session with no running children is simply candidate-less. This phase ships "menu + reference text" only; what consuming an `@label` means (steering the child, resuming a disposed one) is future business work.

The `/client` export surface is the plugin body (`apply`/`inject`) only; the source object is internal to the registration effect.

## Model Experience

### Subagent label text in the user prompt

#### What the model sees

A picked candidate lands the literal `@label` (the child session's display title) in the draft; the text reaches the model verbatim inside the ordinary user message (`session.prompt`), with no dedicated content block, prompt section, or host-side resolution. No consumption semantics exist yet: the model sees plain text and interprets it unaided.

#### Token effect

Conditional and tiny: only a pick (or hand-typing the same text) adds the label's characters to that one user message. Menu browsing adds zero model tokens (candidates never leave the browser).

#### KV Cache effect

Append-only: the reference is part of a new user message appended after the reusable history prefix. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

- **`@` consumption semantics are unbuilt** — the reference is inert text; wiring it to steer/message the named child (and whether resuming a disposed child is allowed) awaits its own design decision in the ledger.
- **Candidates are running children only** — completed or disposed subagents never appear, and the roster is the scoped session's direct children (no grandchildren, no cross-session agents).
- **Labels are display titles, not stable ids** — two children sharing a display title produce indistinguishable references, and a title change orphans previously inserted text. Acceptable while references are inert; a consumption feature must bind to session ids.
