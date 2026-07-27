# Agent Note: The dispose ladder belongs to its consumer, not the subprocess seam

Status: implemented

English | [中文](2026-07-27-dispose-ladder-to-consumer.zh.md)

## Problem

`SubprocessHandle.dispose(graces)` and `SubprocessDisposeGraces` put a full teardown *policy* — stdin-EOF wait, then SIGTERM, then SIGKILL, each tier bounded by a caller-supplied window — on a seam whose other verbs are single mechanisms. Only one consumer ever called it (the ACP subagent backend); bash rides `terminate()` and service teardown, and the LSP host runs its own protocol-first shutdown. Every future backend nonetheless had to implement the ladder to satisfy the interface, and the implementation carried a `dsh-timeout` dependency solely for the ladder's tier bounds.

## Decision

The ladder moves to its one consumer. `dsh-subagent-acp` owns `disposeAcpChild(child, eofGraceMs, graceMs)`, built entirely on the seam's public verbs: close `stdin`, bound a `waitForExit` on `eofGraceMs`, then `terminate()` (whose SIGTERM→spec-grace→SIGKILL escalation already encodes the signal tiers), then a final bounded whole-tree wait that throws if survivors remain. The seam keeps `kill`/`terminate`/`waitForExit` — mechanisms, not policy — and `waitForExit(signal?)` is exactly the quiescence probe a consumer ladder needs to hold each tier on real tree exit. `dsh-subprocess-local` drops its `dsh-timeout` dependency; the seam's handle loses one method and one exported interface.

## Alternatives considered

**Keep the ladder on the handle as a convenience.** Rejected: a seam method every implementation must provide is not a convenience, it is contract surface — and this one encodes one consumer's cooperation shape (stdin-EOF-first) as if it were process vocabulary. The seam's own README already had to caveat that children quiescing on other signals need "their own tier-1", which is the admission that the ladder is policy.

**Move the ladder to a shared helper package.** Rejected: one consumer. A second out-of-process backend with the same stdin-EOF cooperation shape can lift `disposeAcpChild` to shared code when it exists; extracting now would recreate `dsh-subagent-subprocess`, the single-purpose library this stack just deleted.

## Consequences

Bought: the seam is one method and one type smaller; implementations owe four verbs and no teardown policy; `dsh-subprocess-local` loses a dependency; the ladder's tier windows live beside the config fields that tune them. Cost: a future backend wanting EOF-first teardown writes ~20 lines against the verbs (or lifts the ACP helper); the ladder's tier-tier tests moved from the seam suite to the ACP suite, and the seam suite pins the verbs the ladder composes (bounded `waitForExit` false-then-true across an escalation) instead of the composed policy.
