# spill/ - spill storage capability family

The tool-output spill capability seam: an abstract storage interface, a local filesystem implementation, and the tool-result policy that uses it. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `spill/` | Abstract spill storage seam (`saveText` — persist oversized tool text and return a locator + retrieval hint) | `ctx.spillStore` |
| `spill-local/` | Local-filesystem backend: private, session-scoped files with traversal-safe names | (registers on `ctx.spillStore`) |
| `spill-policy/` | `tools/post-execute` policy: replaces oversized plain-text results with a preview + spill locator | (no service surface) |

The interface lives at `spill/spill/`. The split mirrors bash/fs: the seam owns storage only, `spill-local` owns the filesystem mechanics, and `spill-policy` owns WHEN to spill and the model-facing notice. Preview mechanics stay in [`util/retention`](../util/README.md) — the policy composes the two without either owning the other's job.

See the [tool output spill Agent Note](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) for the design rationale, including why final-result spill is separate from tool-owned early spill (bash streams, subagent rollouts) and why creation belongs to the runtime spill seam rather than the model-facing `write` tool.
