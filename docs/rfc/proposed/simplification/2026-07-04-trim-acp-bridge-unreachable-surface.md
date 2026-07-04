# RFC: Trim unreachable ACP bridge surface — the branding knobs and the kind-sniffing fallback

Status: proposed

## Problem

Two pieces of `dsh-acp` surface are unreachable from any shipped configuration:

1. **`AcpConfig.agentName` / `agentVersion`** (`packages/ui/acp/src/index.ts`). The shipped app package hands the bridge only `{ model, systemPrompt }` (`packages/ui/acp-agent/src/index.ts`), so no leaf `cordis.yml` — the only production config surface — can set the knobs at all; they are settable solely by direct-mounting the bridge, which only a unit test does. Every snapshot golden — the hook-matrix scenarios included — pins the schema defaults (`deepseek-harness-acp` / `0.0.1`). The pair also carries a live `TODO(double-default)`: the literals exist twice (schema `.default(...)` plus `??` fallbacks), with the TODO asking to pick one home.
2. **The `toolKindFor` name heuristic** (same file) special-cases `bash*`/`read*`/`write`/`edit*` tool names in the generic-fallback path. Since the [render-intent union](../../implemented/architecture/2026-07-02-tool-render-intent-union.md), every first-party tool those arms match ships its own `presentCall` carrying its kind, and the presenter-less production tools (`subagent`, `subagent_fork`) fall through to `other` anyway. The arms are production-reachable only when a tool's `presentCall` THROWS (the containment fallback) — and the bridge's own module doc states the design rule the heuristic violates: "the bridge never special-cases tool names".

## Proposal

Hardcode `agentInfo` at the `initialize` site (`{ name: 'deepseek-harness-acp', version: '0.0.1' }`), deleting the two config fields, their schema defaults, the `??` fallbacks, and the `TODO(double-default)` whose subject vanishes; drop the knob half of the direct-mount config test, the two rows in `packages/ui/acp/README.md`, and the `packages/ui/acp/acp-feature-support.md` cell that cites the knobs. Zero golden churn — the emitted wire value is unchanged. Replace `toolKindFor` with the constant `'other'` in both fallback sites (the presenter fallback and `nullToolPresenter`) and delete the heuristic with its test rows.

## Why not keep them?

`agentInfo` is client-visible branding a deployment will eventually want configurable — but a knob no shipped config can reach is not configurability, it is drift surface (the double-default TODO is its symptom), and the honest re-add must include the `dsh-acp-agent` plumb-through that does not exist today either; both arrive together with the deployment that needs them. For the heuristic: a hypothetical third-party presenter-less tool named `read_docs` would lose its inferred `read` icon — but inferring kinds from unknown plugins' names is exactly the special-casing the render-intent design rejected. The behavior delta on shipped paths is confined to the presenter-throw fallback, where rendering kind `other` makes the client show the raw input instead of a masquerading first-party card — strictly better diagnostics for a broken presenter.

## Acceptance criteria

- `agentName`/`agentVersion` and `toolKindFor` appear only in this RFC; snapshot goldens are byte-identical; bridge tests are green with the constant fallback.
- The `initialize` handshake continues to report `deepseek-harness-acp`/`0.0.1` (pinned by the handshake snapshot).

## Risks

None beyond the presenter-throw rendering delta described above — an error path whose new behavior is more diagnosable than the old.
