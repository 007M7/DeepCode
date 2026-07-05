# RFC: Trim unreachable ACP bridge surface — the branding knobs and the kind-sniffing fallback

Status: implemented

## Problem

Two pieces of `dsh-acp` surface were unreachable from any shipped configuration:

1. **`AcpConfig.agentName` / `agentVersion`** (`packages/ui/acp/src/index.ts`). The shipped app package hands the bridge only `{ model, systemPrompt }` (`packages/ui/acp-agent/src/index.ts`), so no leaf `cordis.yml` — the only production config surface — could set the knobs at all; they were settable solely by direct-mounting the bridge, which only a unit test did. Every snapshot golden — the hook-matrix scenarios included — pins the schema defaults (`deepseek-harness-acp` / `0.0.1`). The pair also carried a live `TODO(double-default)`: the literals existed twice (schema `.default(...)` plus `??` fallbacks), with the TODO asking to pick one home.
2. **The `toolKindFor` name heuristic** (same file) special-cased `bash*`/`read*`/`write`/`edit*` tool names in the generic-fallback path. Since the [render-intent union](../architecture/2026-07-02-tool-render-intent-union.md), every first-party tool those arms matched ships its own `presentCall` carrying its kind, and the presenter-less production tools (`subagent`, `subagent_fork`) fell through to `other` anyway. The arms were production-reachable only when a tool declined to present its own call — a `presentCall` that THROWS (the containment fallback), or model arguments that fail the tool's schema so `defineTool`'s `presentCall` wrapper returns `undefined` (e.g. a `bash` call missing the required `description`) — and the bridge's own module doc states the design rule the heuristic violated: "the bridge never special-cases tool names".

## Decision

`agentInfo` is hardcoded at the `initialize` site (`{ name: 'deepseek-harness-acp', version: '0.0.1' }`); the two config fields, their schema defaults, the `??` fallbacks, and the `TODO(double-default)` (whose subject vanished with them) are gone, along with the knob half of the direct-mount config test, the two config rows in `packages/ui/acp/README.md`, and the `packages/ui/acp/acp-feature-support.md` cells that described the knobs and the name inference. The emitted handshake wire value is unchanged — zero golden churn on the branding half. `toolKindFor` is replaced by the constant `'other'` at both fallback sites (the presenter fallback and `nullToolPresenter`), and the heuristic is deleted with its test rows. The fixed handshake identity stays pinned by the bridge's initialize unit test and by every snapshot golden. On the fallback half the transcript delta shows up in exactly one committed golden: `hook-codex-posttool-block`, whose recorded model omits the required `description` on three `bash` calls, so those cards take the declined-to-present fallback and carry `kind: 'other'` — the honest neutral card for a call the tool would not vouch for.

## Alternatives considered

### Why not keep them?

`agentInfo` is client-visible branding a deployment will eventually want configurable — but a knob no shipped config can reach is not configurability, it is drift surface (the double-default TODO was its symptom), and the honest re-add must include the `dsh-acp-agent` plumb-through that does not exist either; both arrive together with the deployment that needs them. For the heuristic: a hypothetical third-party presenter-less tool named `read_docs` loses an inferred `read` icon — but inferring kinds from unknown plugins' names is exactly the special-casing the render-intent design rejected. The only shipped paths the heuristic reached were the declined-to-present fallbacks (a throwing `presentCall`, or schema-invalid model args); rendering kind `other` there makes the client show the raw input instead of a masquerading first-party card — strictly better diagnostics for a broken presenter or a malformed call.

## Consequences

Nothing beyond the fallback rendering trade described above — degenerate paths whose neutral card is more diagnosable than an inferred first-party one.
