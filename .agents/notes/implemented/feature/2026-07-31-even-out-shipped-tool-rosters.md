# Agent Note: Even out the shipped tool rosters

Status: implemented

English | [中文](2026-07-31-even-out-shipped-tool-rosters.zh.md)

## Problem

The two shipped `dsh` surfaces offered different tools for no recorded reason. Session checkpoints, tool-result pruning, the goal tools, and Ralph were in `tui.cordis.yml`; `tool-todo` and, later, web search were in `web.cordis.yml`. Neither surface offered session search, a string-replacement editor, or a repeat-tool guard, though all three exist as packages and none is surface-specific.

The result was a user-visible difference nobody had decided: the same model, asked the same thing, could set a goal on the terminal but not in the browser, and could search the web in the browser but not on the terminal.

## Decision

The rows that are not surface-specific move into [`base.cordis.yml`](../../../../apps/cli/config/base.cordis.yml), and three more join them: `tool-session-query`, `tool-str-replace-editor`, and `repeat-tool-guard`. Web search moves there too; its [deployment decision](2026-07-31-web-default-search.md) owns the security boundary while the shared base owns its surface-neutral mount. Both surfaces now assemble the same roster: twenty-five tools on every host, plus `glob` and `grep` when ripgrep is available.

Two rows stay surface-specific. `tmux-context` is TUI-only because a browser surface has no terminal multiplexer to describe. `session-reference` is TUI-only because it drives the shared session-query index from the launcher's process-local path, and the browser sidebar reconciles that index on its own first search.

**This roster decision adds only.** No tool row is removed from either surface, and a catalog comparison finds additions and nothing else. The shared executors, sandbox composition, and access default are owned independently by the [workspace-write default decision](2026-07-31-workspace-write-surface-default.md).

### What stays unmounted, and why

Three capabilities stay out on the evidence their own packages record, and are listed here so "we forgot" and "we decided against" stay distinguishable.

**`dsh-tool-cordis`** lets the model write JavaScript and mount it as a temporary plugin. Its README states the limit: "The sandbox is containment for honest code, not a security boundary — host-realm helpers on the sandbox global are reachable, so mount code can reach Node" ([Known limitations](../../../../packages/cordis/tool-cordis/README.md)). The `node:vm` realm lives inside the harness process while `dsh-sandbox-local` confines only the argv it spawns, so on the Web surface both the sandbox and the approval seam are bypassed rather than enforced.

**`dsh-web-fetch-local`** stays unmounted and `dsh-tool-web` keeps `fetch: false`. SSRF protection is deferred in the implementation ([`policy.ts`](../../../../packages/web/web-fetch-local/src/policy.ts) validates protocol, credentials, and length only) and the package says so: "this provider is an SSRF primitive and **must not be enabled** in a deployment that can reach sensitive internal network targets" ([README](../../../../packages/web/web-fetch-local/README.md)). The model chooses the target, which includes the harness's own gateway on loopback, private ranges, and cloud metadata endpoints.

Withholding it narrows the surface without removing the reach: `bash` is mounted, so `curl` gets the same page, as a live run confirmed. What the absence buys is the removal of an argument-shaped request primitive that needs no shell — and with it the accidental path where a summarization request quietly reaches loopback. A deployment that must contain outbound traffic needs a network-level control.

**The LSP trio** stays out for an operational reason rather than a security one: `command` resolves from `PATH` at plugin load, so a missing language server fails the whole boot rather than one tool. It becomes mountable once absence degrades to a skipped registration.

### MCP is a dependency, not a row

`@deepseek-ai/dsh-mcp-client` becomes a runtime dependency of the CLI without a row in any shipped config. The plugin mounts exactly one server per instance and `command` is required, so a default would have to name a third-party server and spawn it as a child process on every launch — outside `ctx.bash`, and therefore outside the sandbox policy the Web surface composes.

The layer that would make MCP a default is the one this repository does not have yet: a bridge that reads a user's server list and mounts one client per entry, the same shape [`dsh-hooks-claude`](../../../../packages/hooks/hooks-claude/README.md) already has for a Claude Code `hooks.json`. Shipping the dependency means an installed `dsh` can mount servers from `$DSH_HOME/config.yaml` today; the CLI README carries the YAML.

## Testing

[`apps/cli/tests/shipped-composition.e2e.ts`](../../../../apps/cli/tests/shipped-composition.e2e.ts) boots the shipped tree through the real Loader in a pseudo-terminal and reads the tool names out of the `request/header` the session log persisted, so the assertion is the catalog the model was actually sent. Its `--config` overlay, [`composition-keyless-tail.cordis.yml`](../../../../apps/cli/tests/fixtures/composition-keyless-tail.cordis.yml), is test isolation only: a network-free adapter and workspace-local session artifacts.

That tail also inserts [`composition-settled.ts`](../../../../apps/cli/tests/fixtures/composition-settled.ts), which announces settled Loader activation on the terminal stream. The TUI renders as soon as its own fiber starts, so a prompt typed at the banner can reach the loop while tool rows and persistence are still activating and assemble a partial catalog; gating the smoke's first prompt on that marker is what makes the assertion deterministic.

The same smoke also pins the TUI execution posture from the same artifact. Those sandbox-schema and initial-permission assertions belong to the [workspace-write default decision](2026-07-31-workspace-write-surface-default.md), independently of this roster.

[`apps/web/tests/shipped-composition.e2e.ts`](../../../../apps/web/tests/shipped-composition.e2e.ts) covers the Web surface in the built lane, asserting its catalog, that its access default is untouched, and that `workspace-write`'s writable roots include the temp directories — a trap that makes sandbox tests lie when the workspace sits under `/tmp` ([`roots.ts`](../../../../packages/sandbox/sandbox/src/roots.ts)).

`glob` and `grep` are asserted as an all-or-nothing pair rather than fixed members: `dsh-tool-fs-search` probes `command -v rg` at load and registers neither tool without ripgrep, which is a host dependency.

Beyond the committed tests, both surfaces were driven against a real key from the built `apps/cli/lib/bin.js` under plain Node. Every mounted tool executed successfully, including `ralph` and `web_search`; the model never reached `cordis_*` or `mcp_*`, fell back to `grep` when asked for LSP navigation, and used a background `bash` task when asked for a persistent terminal.

## Alternatives considered

**Duplicate the shared rows into both overlays instead of promoting them.** Rejected on the one-home rule: three of the new rows would exist twice with no reason for the copies to diverge, and the next roster change would have to remember both.

**Sandbox the TUI in the same change.** Rejected as a separate decision that does not belong in a roster change: the TUI mounts unrestricted executors, and replacing them alters what an existing surface does rather than what it offers. That decision needs its own evidence — not least because the TUI has no `approval/request` answerer, so an escalation there fails closed instead of prompting.

**Enable Code Mode.** Its trust posture is bash-equivalent by design and its tool calls pass the same `tools/pre-execute` gate as bash, so it is not the same call as the model-code tools above. Rejected here anyway: `both` changes every model-visible request on both surfaces, and `code` replaces the wire rather than adding to it — either is a presentation decision, not a roster one.

**Mount an MCP server by default.** Rejected because a shipped default would have to name one, and any choice spawns a third-party child process on every user's machine outside the sandbox. The dependency ships instead.

## Consequences

The same model gets the same tools on both surfaces, and the difference that existed for no recorded reason is gone. The tests assert the twenty-five unconditional names exactly and require the ripgrep-dependent pair to be either present together or absent together on both sides, so a later change that alters only one surface fails a check instead of shipping quietly.

`apps/cli` gains five workspace dependencies: four the shipped tree now mounts, plus `dsh-mcp-client`, which it does not mount and which exists so an installed `dsh` can.

Execution policy stays independent of the roster. The [shared workspace-write decision](2026-07-31-workspace-write-surface-default.md) owns both surfaces' sandboxed executors and default permission; changing that policy does not add or remove a tool.
