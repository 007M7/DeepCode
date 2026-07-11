# sandbox-acp-agent

The coding agent with its bash executor swapped for the sandbox stack ([`@deepseek-ai/dsh-sandbox-local`](../../packages/sandbox/sandbox-local/) + [`@deepseek-ai/dsh-bash-sandbox`](../../packages/bash/bash-sandbox/) — the one-entry executor swap the `ctx.bash` capability seam exists for), served over the **Agent Client Protocol**, plus [`@deepseek-ai/dsh-user-approval`](../../packages/ui/user-approval/) — which makes this the first composition where the approval loop is LIVE end to end: bash runs under `read-only`, a denial comes back as the structured marker, the model retries once with `sandbox_permissions` + `justification`, the ACP bridge's answerer turns that ask into a `session/request_permission` prompt in your editor, and "Allow once" runs exactly that command under the wider mode ([sandbox RFC § Escalation](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)).

```sh
pnpm run demo:sandbox-acp   # needs DEEPSEEK_API_KEY; drive it from Zed or any ACP client
```

Zed setup is the same as [acp-agent](../acp-agent/README.md) with this example's command; only the leaf `cordis.yml` differs (the sandbox stack + the approval entry in place of the local bash executor and the extra tool stacks).

- **Every approval is one-shot** (`Allow once` / `Reject` — no `allow_always`: the harness has no grant storage yet), and a dismissed prompt or a rejected ask fails closed with its own error text; so does every ask when no editor is attached to answer.
- **Two session config options are live** ([sandbox RFC § Per-session mode switching](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)): a capable client shows `Sandbox` (`read-only`/`workspace-write`/`danger-full-access`) and `Approvals` (`ask`/`never`) selectors per session — a switch is one log-only event on that session's log and execution follows it; the sandbox mode is deliberately NOT stated in the prompt or narrated (the model learns the boundary from the denial marker — behavior, not belief), while an approval switch to `never` is stated and narrated; a resumed session reports its overrides back on `session/load`.
- **The write boundary is config-fixed**: an escalated `workspace-write` run may write under the launch directory (`workspaceRoot: process.cwd()`) plus the platform temp area — a per-session root is config-phase future work in the [sandbox RFC](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md).
- **No usable runner fails closed per command** (structured `SANDBOX_UNAVAILABLE`), and the filesystem tools stay unloaded for the same reason as `sandbox-agent`: they would bypass the bash sandbox.

`tests/escalation.e2e.ts` boots the real composition keylessly and exercises config-option advertisement, updates, and validation; with a key and usable runner it also world-verifies an allowed escalation. `tests/acp.snapshot.ts` pins config exchange, mode switching, and allowed and rejected approval branches through the shared snapshot kit. Replay executes recorded bash calls on the host runner, so Linux needs bubblewrap or Landlock while macOS uses Seatbelt. Fixtures avoid real denial stderr because that dialect is platform-specific.
