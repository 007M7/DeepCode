# DeepSeek Harness

Ubiquitous language for the harness. Started during the 2026-07-05 system-prompt redesign session; grows as terms crystallize. Decisions live in `docs/rfc/` (this repo's ADR equivalent), not here.

## Language — prompt assembly

**Section**:
One named, ordered fragment of the system prompt, contributed by a plugin through `ctx.systemPrompt.section()`.
_Avoid_: block, snippet

**Assembly**:
The collated output of `assemble()` — sections, tool schemas, and resolved prompt variables — before rendering.

**Full system prompt**:
The rendered text the model actually receives: all sections interpolated and joined. There is no other composition path.
_Avoid_: using "system prompt" for any single fragment

**Persona**:
The per-agent, deployment-authored prompt fragment (config key `systemPrompt` on an agent). A template, not final text; rendered as the order-0 section. It is one section of the full system prompt, never the whole.
_Avoid_: calling it "the system prompt"

**Prompt variable**:
A named per-assembly value contributed by a plugin (e.g. `model`) and referenced from section or persona text as `{{name}}`.
_Avoid_: placeholder, macro

**Assemble context**:
The per-agent input to one `assemble()` call, carrying which agent the prompt is for. Merge-extensible; variable providers and section text providers are functions of it.

**Tool guidance**:
The model-facing usage prose for one tool, owned by the tool's package as a section (order band 100–199) — never hand-written in leaf config.
_Avoid_: tool prompt, tool docs

## Language — subagents

**Context contract**:
Whether a subagent provider's child sees the parent conversation (`inheritsParentContext`): fork inherits the log, spawn and ACP start fresh. Declared by the provider, consumed by tool wording.

