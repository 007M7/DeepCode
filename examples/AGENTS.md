# AGENTS.md — Examples

Runnable demos showing how the harness is wired. **Examples are NOT workspaces** — each `examples/*/package.json` is a private, dependency-free stub, never built. They are booted as unbuilt `tsx` subprocesses via the cordis Loader reading a `cordis.yml`; the `@deepseek-ai/dsh-*` plugin names in those YAML files resolve through the root `tsconfig.json` `paths` map, not through `node_modules`.

Because examples are not under the `packages/*/src` coverage gate, an example that grows real, reusable *logic* should extract it into a `packages/` package (where it gets the per-file 100% gate and a README). Keep only example-specific glue here: the `cordis.yml` wiring, demo-only mocks/teaching artifacts, and the e2e/snapshot scenarios. There is no `start.ts` — the boot glue lives in each app package's `bin` (`@deepseek-ai/dsh-stdio-agent`, `@deepseek-ai/dsh-acp-agent`), which the `demo:*` scripts invoke against the leaf `cordis.yml`.

## Every example ships e2e smokes (keyless + with-key)

Each example must have **both** kinds of end-to-end smoke, because they catch different failures:

- **Keyless smoke** — boot the example through its real `cordis.yml` via the Loader (no API key), drive it, and assert the rendered output and a clean exit. This is the guard a hand-mounted unit test structurally cannot be: it exercises the REAL load path (`unwrapExports`, `inject`, the whole plugin tree), so a broken plugin export shape — e.g. a stray `export default` that collapses a namespace plugin and drops `inject` — fails here even when unit tests stay green (see [docs/postmortem/0001](../docs/postmortem/0001-acp-default-export-drops-inject.md)). It runs in the default e2e gate (CI has no secrets).
- **With-key smoke** — send a real prompt against the live model and verify the WORLD (a file on disk, a non-empty assistant turn), not the agent's self-report. This proves the actual product works, which a mock/keyless run structurally cannot. Key-gated: it self-skips without `DEEPSEEK_API_KEY` (see [the testing policy](../docs/testing.md) — inference is cheap here, so write many).

**Exception — keyless-by-nature examples.** An example whose model is itself a mock/deterministic stand-in (no real provider) has no meaningful with-key smoke; the keyless smoke is the complete requirement. State the exception inline in the test.

A keyless smoke that spawns the example from a temp cwd must set `TSX_TSCONFIG_PATH` to the repo-root tsconfig (the unbuilt `paths` map is found by searching UP from cwd), and pass `--expose-internals` when the `cordis.yml` loads the HMR plugin (mirror the `demo:*` script).

## Current state

| Example | Keyless smoke | With-key smoke |
|---|---|---|
| `echo-agent` | `tests/echo.e2e.ts` — boots the real `cordis.yml`, drives the echo tool round-trip and the direct canned reply | **N/A — keyless by nature** (the `mock-echo` model has no real provider) |
| `coding-agent` | `tests/keyless-smoke.e2e.ts` — boots the full real tree (dummy key, no prompt → no model call), asserts banner + clean exit; `tests/code-mode-keyless-smoke.e2e.ts` — the same boot guard for the Code Mode overlay | `tests/{full-loop,coding-task,resume,compaction,todo-write}.e2e.ts` — real model + real bash + real todo_write, world-verified; `tests/code-mode.e2e.ts` — a real model composes two bash calls in one `run_code` program; collapsed header, dispatch events, written file all verified |
| `cordis-agent` | `tests/keyless-smoke.e2e.ts` — boots the real tree incl. `@deepseek-ai/dsh-tool-cordis` by package name; the tool logic is unit-tested in `packages/cordis/tool-cordis` | `tests/cordis-tools.e2e.ts` — real model mounts a listener (tagged line fires), builds+calls its own tool, composes two mounts via provide/inject |
| `acp-agent` | `pnpm run test:snapshot` — boots the real ACP subprocess and replays a recorded session keyless (incl. the hook matrix: a scenario per hook point × outcome for BOTH the Claude and Codex bridges — block, deny, ask, context-fold, force-continue); `tests/acp.e2e.ts` also asserts stdout purity without a key; `tests/escalation.e2e.ts` boots the default tree (sandbox + approval + permission + bridge) keyless: initialize + `session/new` | `tests/acp.e2e.ts` — real ACP prompt, verifies a file the agent wrote; `tests/hooks.e2e.ts` — a real `PreToolUse` hook blocks bash, verifies the file is NOT written; `tests/escalation.e2e.ts` — denied → escalates → a scripted client grants (the write must land) or rejects (it must not); skips without key/runner |

See [the root AGENTS.md](../AGENTS.md) for repo-wide conventions and [docs/architecture.md](../docs/architecture.md) for the design.
