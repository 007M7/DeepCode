# Defensive patterns

English | [中文](defensive-patterns.zh.md)

Hard-won bug-class rules: each pattern below is a class of defect that actually shipped or nearly shipped here, stated as the rule that prevents its recurrence. Read this before writing lifecycle, concurrency, subprocess, or teardown code. Test-tier counterparts (real entry path, world-verification, resource ownership) are in [testing.md](testing.md).

## Report orthogonal outcomes independently

A result can be several things at once — a process can time out AND exit 0 because it trapped the signal. Surface each independent fact (`timedOut`, `signal`, `exitCode`) on its own; never nest one flag's report inside another's branch, or a caller reads a cut-short run as a clean success.

## Honor cross-seam contracts on BOTH sides

When an interface documents two valid ways to signal something — an adapter may report failure by THROWING from `stream()` or by ending the stream with a `finish {kind:'error'|'aborted'}` chunk — the consumer handles both, not just the one the first implementation used. A library-backed adapter that can't throw mid-stream relies on the in-band path; a loop that only catches throws turns a provider 401 into a normal completed turn. Document the contract where the type is defined; exercise every branch through the real consumer.

## Async state is not synchronous state

`agent.followup()` does not flip status before returning; a background task's completion races turn boundaries; `reader.close()` fires for both EOF and disposal. Never gate control flow on a status you only just requested — drive lifecycle off the events/promises that actually fire (`agent/status`, `task.done`), and observe the transition (saw `running` THEN `idle`) instead of treating status as a per-follow-up result: several queued follow-ups run as consecutive turns under one `running` interval, while cancellation or disposal can discard unstarted items. The guard cuts both ways: if the awaited transition can never occur (EOF with no work submitted → never `running`), the wait hangs — handle the "nothing to wait for" branch explicitly.

## Dispose must reach quiescence, not just request it

A teardown that issues kills/aborts but returns before the work stops leaves orphans. Make cleanup async and await the children's exit (kill → await `done`), and close listener/notification registries BEFORE killing so late completions stay silent.

## Contain callback exceptions at the boundary

A user-supplied listener that throws must not reject the promise it runs inside or starve the listeners after it. Wrap the dispatch loop in try/catch and log; one bad subscriber never breaks core lifecycle.

## Never hand untrusted output the ambient environment or predictable paths

Spawned commands get a scrubbed env (drop `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`) so harness credentials cannot leak into output, `env`, or spill files. Temp/spill files use a private (0700) dir, random names, and exclusive owner-only opens (`'wx'`, `0o600`) — predictable world-readable paths invite symlink races and disclosure.
