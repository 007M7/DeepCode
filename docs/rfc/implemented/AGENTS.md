# AGENTS.md — Implemented RFCs

These are RFCs whose decision has **shipped**. The repo-wide and docs-wide rules still apply ([root AGENTS.md](../../../AGENTS.md) § "Type Safety and Documentation", [docs/AGENTS.md](../../AGENTS.md)); this file adds one rule specific to this folder.

## Keep an implemented RFC current with what actually shipped

An RFC in `implemented/` describes a decision that is now **live code**. Keep its description of the shipped reality accurate: when the implementation later moves a file, renames a package or symbol, changes a config key/default/error code, or relocates a plugin, update the RFC in the **same change** that touches the code — exactly as you would a package README. A stale implemented RFC (pointing at a path that no longer exists, naming a package that was renamed, describing a structure that was refactored) is worse than no RFC: a future reader trusts it and is misled.

Update it **in place** to state the current truth. Do **not** leave the outdated text in and bolt on a "superseded / now actually…" note — that makes the document a changelog of its own drift and forces the reader to reconstruct the present from a pile of corrections. Write what is true now.

### This is not a license to rewrite the *decision*

Keeping the shipped-state description current is about **facts** (paths, names, structure, defaults) — not about silently flipping the **decision and its rationale** into a different one. The "new RFC" escape hatch is for **macro** changes — a genuine reversal of *what was decided* or its rationale — NOT for renames, moves, or structural relocations. A rename is always a fact to fix **in place**: leaving a package/symbol/path at its old name (even with a "was renamed to…" aside) only confuses a reader who greps the current tree for a name that no longer exists. So: the package was renamed, a symbol changed, a plugin moved, the decision is now realized through a different mechanism → edit this RFC to state the current names and structure. Only a reversal of *what was decided* → a new RFC and cross-link, per [rfc/README.md](../README.md) ("An RFC is never edited into a different decision").

When in doubt, ask whether a reader following this RFC to the code would land on something real. If not, it needs updating.
