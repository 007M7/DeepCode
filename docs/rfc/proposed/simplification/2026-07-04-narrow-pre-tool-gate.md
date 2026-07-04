# RFC: Narrow the pre-tool gate to shipped behavior

Status: proposed

## Problem

The `tools/pre-execute` seam advertises two pieces of deferred capability that are not actually supported end to end: interactive `ask` permission and pre-tool argument rewrite.

`PreToolDecision` includes `{ kind: 'ask' }`, but `ToolRegistry.execute()` treats every non-`allow` decision as a denied tool result because no permission UI exists yet ([packages/core/tools/src/index.ts](../../../../packages/core/tools/src/index.ts)). The only production producer is `dsh-hooks-claude`, which maps Claude Code `permissionDecision: "ask"` into that variant; Codex has no allow/ask path. The durable hook log can still record that an external hook asked, but the canonical typed seam cannot do anything distinct with it. The public union therefore has a third branch whose runtime semantics are "deny with a different default string."

The same seam also has an unadvertised argument-rewrite escape hatch. The docs correctly say input rewrite is not offered because `assistant/message`, `tool/call`, and live presentation all see the model's original arguments before execution; changing only `exec.arguments` would make the UI/audit/history disagree with what ran. Yet `ToolExecution.arguments` is mutable, and dispatch reads `exec.arguments` after `tools/pre-execute`, so a listener can rewrite it anyway. A test shim does exactly that to thread a generated bash task id ([packages/bash/tool-bash/tests/integration.spec.ts](../../../../packages/bash/tool-bash/tests/integration.spec.ts)). The proposed [pre-tool input rewrite RFC](../feature/2026-06-30-pre-tool-input-rewrite.md) exists because doing this consistently is a design unit, not a hidden mutation.

Both shapes are honest feature deferrals, but the public seam currently encodes them as if they were ready. That makes bridge code, docs, generated catalogs, and tests explain behavior whose only shipped result is "deny" or "mutate at your own risk."

## Proposal

Make `tools/pre-execute` express the behavior it can actually provide today: allow or deny a pending tool call, without argument mutation.

- Remove `{ kind: 'ask' }` from `PreToolDecision`. The Claude bridge should still parse and log hook `ask` decisions, but map them to `deny` at the typed seam with an approval-not-supported reason until a real permission prompt exists.
- Update docs, generated catalogs, hook bridge README tables, and tests so `tools/pre-execute` is an allow/deny gate, not an allow/deny/ask gate.
- Make `ToolExecution.arguments` immutable by contract. At minimum mark it `readonly` and stop relying on a listener-mutated `exec.arguments` for dispatch; if a defensive runtime copy/freeze is needed to make the contract true, add it at the `ToolRegistry.execute()` boundary.
- Rewrite the one test shim that mutates `exec.arguments` to use a behavior-level helper instead of the hidden rewrite path.

When permission prompts or consistent input rewrite lands, reintroduce the smallest explicit decision shape those features need. `ask` belongs with a real user approval loop; argument rewrite belongs with the audit/history/presentation update described by the proposed rewrite RFC.

## What we give up

Claude `permissionDecision: "ask"` no longer has a distinct typed-decision branch inside `dsh-tools`. The bridge can still preserve the external fact in `hook/result.decision` and still deny the call conservatively. That matches current product behavior without requiring every native plugin to handle an unusable branch.

Internal tests lose a convenient mutable-object trick. That is a good loss: public tests should not depend on an unadvertised inconsistency that production docs warn against.

## Acceptance criteria

- `PreToolDecision` contains only `allow` and `deny`.
- `dsh-hooks-claude` still records hook `ask` in hook provenance, but returns a `deny` decision to `tools/pre-execute`.
- `rg "kind: 'ask'|PreToolDecision.*ask|ask.*degrades" packages docs --glob '!docs/rfc/**'` finds no remaining public pre-tool ask contract outside historical RFC text.
- `ToolExecution.arguments` is no longer a writable rewrite path, and `rg "exec\\.arguments\\s*=" packages examples --glob '!docs/rfc/**' --glob '!**/lib/**'` finds no mutation.
- The proposed pre-tool input rewrite RFC remains the future home for a consistent rewrite design.
- `pnpm run test:coverage`, `pnpm run test:snapshot`, `pnpm run doc-sync`, and `pnpm run hygiene` pass after implementation.

## Risks

- A native plugin author may already have experimented with `ask`. The repo is unreleased, and the branch currently cannot prompt a user; collapsing it now avoids shipping a promise that cannot be honored.
- Making arguments immutable may reveal more test helpers that were relying on mutation. Those helpers should move closer to the behavior they actually need instead of preserving a public inconsistency.
- Future permission and rewrite work will add back surface area. That is fine; the new surface should land with the product workflow and consistency guarantees that make it real.
