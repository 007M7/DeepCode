# ADR 0006: Tool schemas are part of the system-prompt assembly

Status: accepted (2026-06-11)

## Context

On the wire, tool schemas travel in a dedicated `tools` field of the model
request, not in prompt text. Architecturally, though, "what the model is told
it can do" is one coherent concern: prompt sections and the tool list are
assembled from the same plugin contributions and consumed at the same moment.
The alternative — the loop querying the tool registry separately from the
prompt service — splits one concern across two seams.

## Decision

`PromptAssembly { sections, tools }`: the system-prompt service collects
ordered text sections AND tool schemas (the tool registry auto-contributes a
provider). The loop consumes one assembly per step; adapters map `sections`
to the provider's system slot and `tools` to the wire `tools` field. The
`system-prompt/assemble` waterfall is therefore a single interception point
for everything the model is told up front — tool filtering (ToolSearch /
progressive disclosure) is an assembly rewrite, same as prompt edits.

## Consequences

- One waterfall governs the model's standing context; plugins like plan mode
  can swap prompt text and visible tools in one listener.
- The assembly interface is merge-extensible for future slots (no untyped
  `extras` bag — extension is declaration merging).
- Slight conceptual surprise (schemas in a "prompt" service) is documented
  here and in the package README.
