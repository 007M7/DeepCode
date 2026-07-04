# hooks/ — hook bridges + shared protocol

The hooks subsystem lets users extend the agent at lifecycle points the way Claude Code and Codex do — by pointing a bridge plugin at an existing `hooks.json` (or settings) so those external shell hooks run faithfully. The canonical extension surface itself is the harness's typed interception seams ([the interception-seams RFC](../../docs/rfc/implemented/feature/2026-06-30-interception-seams.md)); a "native hook" is just an ordinary cordis plugin on those seams. These packages are the **bridges** that translate the external shell-hook protocol onto that same surface, plus the shared wire-protocol library they build on.

| Package | Role | Shape |
|---|---|---|
| `hook-protocol/` | Shared wire-protocol core: matcher primitive, exit-code/stdout codec, `runHook` (via `ctx.bash`), most-restrictive merge, `hook/*` session events | library (no plugin) |
| `hooks-claude/` | Bridge for a Claude Code `hooks.json` / settings | plugin |
| `hooks-codex/` | Bridge for a Codex `hooks.json` | plugin |

Codex deliberately reimplements a *subset* of the Claude Code protocol (same `hooks.json` shape, 5 events vs CC's many, command-only, regex-only matcher, no env/substitution), so `hook-protocol` owns the genuinely-identical primitives and each bridge owns only what differs (its per-event stdin payload, env, and the mapping of a hook's neutral outcome onto the harness's typed Decisions). See [hook-protocol/README.md](hook-protocol/README.md).
