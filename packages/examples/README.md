# examples/ — ready-to-run demo bundles

Pre-composed plugin bundles a thin leaf `cordis.yml` loads instead of assembling the spine and a front door by hand. These are **demo / reference** packages — the `-demo` npm suffix marks each one as non-product surface, readable straight off the package name. The runnable leaves under the repo-root [`examples/`](../../examples/AGENTS.md) and the [Python SDK runtime](../../python/sdk-runtime/README.md) are the consumers; each is just its swappable backends plus one bundle entry.

| Package | npm name | Role |
|---|---|---|
| `agent-spine-demo/` | `@deepseek-ai/dsh-agent-spine-demo` | The executor-less/UI-less agent spine as one bundle plugin, with fallback session titles and an opt-in persisted-goal stack |
| `tui-demo/` | `@deepseek-ai/dsh-tui-demo` | Full-screen terminal app bundle: the spine + persisted goals + `/goal` command + JSONL persistence + `dsh-tui` + a pre-created `main` agent; no bin, booted by the [`dsh`](../../apps/cli/README.md) CLI |
| `cli-demo/` | `@deepseek-ai/dsh-cli-demo` | Headless one-shot app: the spine + JSONL persistence + a pre-created `main` agent, with text and DSH-native JSON output |
| `acp-demo/` | `@deepseek-ai/dsh-acp-demo` | ACP automation server app: the spine + persisted goals + JSONL persistence + the [`acp`](../acp/acp/README.md) bridge (no stdout logger), with a boot `bin` |
| `jsonrpc-demo/` | `@deepseek-ai/dsh-jsonrpc-demo` | Bin-only runtime that boots an external `cordis.yml` for the stdio JSON-RPC SDK client |

`agent-spine-demo` is the shared bundle; `tui-demo`, `cli-demo`, and `acp-demo` compose it with full-screen terminal, headless one-shot, and ACP automation front doors. `cli-demo` and `acp-demo` own their boot bins; `tui-demo` ships only the bundle plugin, and the product [`dsh`](../../apps/cli/README.md) CLI is its terminal front door. `jsonrpc-demo` mounts no composition of its own — it boots whatever tree the deployment's `cordis.yml` names, and is what the Python SDK runtime launches.

These are **not** product API. The spine pieces they bundle live in [`core/`](../core/README.md), human/SDK channels and boot glue in [`ui/`](../ui/README.md), the automation transport in [`acp/`](../acp/README.md), and swappable backends in their capability groups; a demo bundle just picks one concrete composition of them. Swap or fork one freely.

Do not confuse this group with the repo-root [`examples/`](../../examples/AGENTS.md): that directory holds the runnable `cordis.yml` **leaves**; this group holds the **bundles** those leaves load.

## The jsonrpc bin/exe names are legacy

`jsonrpc-demo` renamed like its siblings, but its bin is still `dsh-jsonrpc-agent` and the single-file executable is still `dsh-jsonrpc-agent-pkg` (referenced across the [Python distribution](../../python/sdk-runtime/README.md)). Those names are the SDK's runtime-startup surface; they are reconciled when the SDK unifies that startup flow, not by this move.
