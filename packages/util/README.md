# util/ — low-level shared utilities

English | [中文](README.zh.md)

Zero-dependency primitives shared across the other groups. A package lands here when it owns a tiny, foundational type or helper that several capability families need but that belongs to none of them — keeping it out of any one group avoids a capability package depending on an unrelated one just to reach a shared primitive. These are **support** packages: small, stable, and free of harness dependencies.

| Package | Role |
|---|---|
| `brand/` | The type-only `Branded<B>` nominal-typing primitive (no runtime code, no harness deps) |
| `paths/` | Canonical single-root `DSH_HOME` resolution plus shared filesystem path constants and helpers for harness user data (no harness deps) |
| `timeout/` | The timing/classification half of a timeout — `clampTimeout`/`deadline`/`timeoutOf`/`TimeoutReason` (pure functions, no harness deps); termination stays in each capability |
| `retention/` | Bounded model-facing output — `ItemRetainer`/`TextRetainer` + neutral notice helpers (pure, no harness deps); business semantics stay in each tool |
| `native-command/` | No-shell `execFile` runner for host-native OS integrations — utf8 capture, abort propagation, Windows hide (no harness deps); command choice stays in each caller |

`dsh-brand` is the canonical case: it owns ONLY the `Branded<B>` helper, so a capability package can brand the ids it owns (`dsh-tasks`'s `TaskId`, `dsh-session`'s `SessionId`, …) by depending on `dsh-brand` alone, without pulling in an unrelated package just to reach `Branded`.

`dsh-paths` gives every package the same configurable Harness home without assigning that cross-cutting fact to bash, skills, telemetry, or a composition bundle. It resolves an explicit value before `$DSH_HOME`, falls back to `~/.dsh`, and returns an absolute path without caching, creating, or mutating anything. The harness keeps all user data under one root.

`dsh-timeout` follows the same shape for the timeout family: `dsh-bash` and `dsh-web-fetch-local` each fuse a caller's cancellation with a deadline and later classify "timed out" vs "cancelled" by depending on `dsh-timeout` alone. It deliberately owns only the timing/classification half — the *termination* (SIGKILL a process group, tear down a fetch socket) stays in each capability, because no shared layer can own every capability's kill (see [the timeout-library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md)).

`dsh-retention` is the same split for bounded tool output: a tool (`glob`/`grep`/`bash`/`web_fetch`/`web_search`) feeds items or text into a retainer and gets back what it kept and exactly what it omitted — while grouping, exit codes, provider errors, and recovery prose stay tool-owned. It deliberately owns only the retention mechanic; `truncated` is a budget fact, never an "incomplete inspection" state (see [the retention-library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-tool-result-retention-library.md)).
