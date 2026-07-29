# code-mode

English | [中文](README.zh.md)

Code Mode over the shipped TUI: the model stops calling one tool per turn and instead writes TypeScript programs for a single `run_code` tool, executed in a worker thread.

This leaf is an **overlay**, not a tree. `dsh --config` includes the shared [`apps/cli/base.cordis.yml`](../../apps/cli/base.cordis.yml), applies the [`tui.cordis.yml`](../../apps/cli/tui.cordis.yml) surface overlay, then applies this file — all as sibling patch lists at one include level.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:code-mode
```

`pnpm run demo:code-mode acp` boots the same idea over the ACP transport from [`examples/acp-agent/code-mode.cordis.yml`](../acp-agent/code-mode.cordis.yml).

## What the overlay changes

| Row | Change |
| --- | --- |
| `tools` | `mode: code` — the wire registry collapses to `run_code` plus its generated TypeScript SDK prompt section |
| `system-prompt` | a persona telling the model to batch tool work into one program |
| `tui` | a Code Mode welcome line |
| `code-runtime` | inserted: `@deepseek-ai/dsh-code-runtime-worker`, the worker thread `run_code` executes in |

Everything else — the model backend, executors, filesystem tools, persistence, delegation, and the front door — comes from the base and the TUI overlay.

A patch replaces a row's whole `config` rather than merging into it, so each row above restates every key it owns. A patch whose `id` matches no row is skipped with a Loader warning, so renaming a row in the base or the surface overlay requires updating this file.

## Model Experience

The model sees one tool instead of the full native registry. Its request carries the `run_code` schema and a generated TypeScript SDK section describing the callable surface, which costs more prompt tokens up front but replaces many single-call turns with one program — fewer round trips and fewer intermediate tool results in the transcript. Because the tool catalog is part of the cached request prefix, switching modes invalidates the KV cache for the session.
