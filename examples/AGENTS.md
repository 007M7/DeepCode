# AGENTS.md — Examples

Runnable harness compositions. **Examples are not workspaces:** their private package stubs are not built; `tsx` and the Cordis Loader resolve package names through the root `tsconfig.json` paths.

Keep only wiring, demo-only fixtures, and e2e/snapshot scenarios here. Move reusable logic into `packages/`, where coverage and README requirements apply. App-package bins own bootstrapping; examples have no `start.ts`.

## Every example ships e2e smokes (keyless + with-key)

Each example has both smoke tiers:

- **Keyless:** boot the real `cordis.yml` through the Loader, drive it, and assert output plus clean exit. This catches Loader/export-shape failures that hand-mounted tests miss ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **With-key:** send a live-model prompt and verify external state, not the model's claim. Self-skip without `DEEPSEEK_API_KEY`; see [testing.md](../docs/testing.md).

Mock-only examples need only the keyless tier; state the exception in the test.

A keyless smoke launched from a temporary cwd sets `TSX_TSCONFIG_PATH` to the root tsconfig and passes `--expose-internals` when loading HMR.

## Current state

| Example | Keyless smoke | With-key smoke |
|---|---|---|
| `echo-agent` | `tests/echo.e2e.ts` — boots the real `cordis.yml`, drives the echo tool round-trip and the direct canned reply | **N/A — keyless by nature** (the `mock-echo` model has no real provider) |
| `coding-agent` | `tests/keyless-smoke.e2e.ts` — boots the full real tree (dummy key, no prompt → no model call), asserts banner + clean exit; `tests/code-mode-keyless-smoke.e2e.ts` — the same boot guard for the Code Mode overlay | `tests/{full-loop,coding-task,resume,compaction,todo-write}.e2e.ts` — real model + real bash + real todo_write, world-verified; `tests/code-mode.e2e.ts` — a real model composes two bash calls in one `run_code` program; collapsed header, dispatch events, written file all verified |
| `cordis-agent` | `tests/keyless-smoke.e2e.ts` — boots the real tree incl. `@deepseek-ai/dsh-tool-cordis` by package name; the tool logic is unit-tested in `packages/cordis/tool-cordis` | `tests/cordis-tools.e2e.ts` — real model mounts a listener (tagged line fires), builds+calls its own tool, composes two mounts via provide/inject |
| `sandbox-acp-agent` | `escalation.e2e.ts` — boots the real tree (sandbox + approval + bridge) keyless: initialize + `session/new` | same file — denied → escalates → a scripted client grants (the write must land) or rejects (it must not); skips without key/runner |
| `acp-agent` | `pnpm run test:snapshot` — boots the real ACP subprocess and replays a recorded session keyless (incl. the hook matrix: a scenario per hook point × outcome for BOTH the Claude and Codex bridges — block, deny, ask, context-fold, force-continue); `tests/acp.e2e.ts` also asserts stdout purity without a key | `tests/acp.e2e.ts` — real ACP prompt, verifies a file the agent wrote; `tests/hooks.e2e.ts` — a real `PreToolUse` hook blocks bash, verifies the file is NOT written |

See [the root AGENTS.md](../AGENTS.md) for repo-wide conventions and [docs/architecture.md](../docs/architecture.md) for the design.
