# Agent Note: Launcher-owned session identity and exit line

Status: implemented

English | [中文](2026-07-28-launcher-owned-resume-identity.zh.md)

## Problem

Two facts a launcher owns were shipped as deployment config keys on the TUI app bundle: `resumeSessionId` (which session `main` binds to) and `resumeCommand` (the exit hint template, with `{session}` interpolated). Neither varies by deployment — both are properties of how the process was invoked, which only the launcher knows.

Routing them through YAML made them silently droppable. `@cordisjs/plugin-include` applies a targeted patch by replacing whole top-level keys (`target[key] = value`), so a personal `~/.dsh/config.yaml` patching the `tui-agent` entry's `config` replaces the shipped block entirely. A user overlay written to change provider and model therefore deleted every resume key it did not restate, and nothing reported it: absent `resumeCommand` legitimately means "no fallback configured".

Both failures were live in one real overlay. The exit hint stopped printing, because the overlay omitted `resumeCommand`. Worse, the overlay carried `resumeSessionId: !!js process.env.RESUME_SESSION_ID` — a stale line from before [the env-var bridge was removed](../../archived/architecture/2026-07-24-dsh-commander-argument-adapter.md) — which overwrote the shipped `!!js "typeof resumeSessionId === 'string' ? …"` intake with a read of a variable nothing sets. `dsh --resume <valid-id>` then started a *fresh* session and said nothing, reproduced directly: the banner showed a newly minted id, not the requested one. The [`dsh experimental-meta`](../feature/2026-07-28-dsh-meta-source-workspace.md) note had recorded this silent resume as an unexplained pre-existing defect; the overlay's shallow replacement is the cause.

A config key cannot express these facts safely, because the deployment is not the authority on them.

## Decision

Session identity and the exit line are launcher-owned context slots, provided before any Loader entry mounts. Neither appears in any `cordis.yml` nor in any plugin's `Config`.

Both sit beside the existing `tuiResumeHost` host capability, which set the precedent — a resume host has always been a provided capability rather than config. Each slot is declared by the package that consumes it:

- `CONFIGURED_AGENT_IDENTITIES_KEY` (`dsh-agent-loop`) carries launcher identities keyed by configured-agent `id`, each a `LauncherAgentIdentity` (`{ id: SessionId, resume: boolean }`). `agent-loop` applies the matching identity over its configured agent, replacing both identity keys, and takes the history-loading `resumeSessionId` path only when `resume` is set, because that path requires an existing log and fails loud without one. An absent slot leaves the configured identity untouched. The `tui` row resolves the same id through its own `sessionId` key, so the front door renders exactly the agent that was bound.
- `TUI_GOODBYE_MESSAGE_KEY` (`dsh-tui`) carries the complete line printed once the terminal is released on exit. Absent prints nothing.

Identity belongs to `agent-loop` because that is the plugin which creates configured agents, and because a patch replaces a row's whole `config`: an overlay repointing the agent row's model route would erase a launcher-set identity key. See [the shared-base overlay note](../simplification/2026-07-29-shared-base-config-overlays.md).

`apps/cli` mints or selects the id and builds the line from the invocation it is reproducing, sharing one `resumeArgs` helper with the `/resume` execve handoff so the printed command and the in-place handoff cannot diverge. The line names `--config` when one was passed. Resume always re-enters the default surface through `dsh --resume <id>`; `dsh experimental-meta` accepts no options and always starts fresh.

**`ctx.provide` is the only channel from launcher argv into a Loader-mounted plugin.** Config `!!js` expressions evaluate as `with (entry.ctx) { eval(expr) }` (`vendor/loader/src/config/utils.ts`), so a bare identifier resolves against the entry's context and nothing else reaches it. The slot therefore cannot be removed while the app bundle is mounted from YAML; what changes is that it is now internal launcher↔app plumbing instead of a documented key a config author must wire correctly.

The message is a plain string, not a callback. That forces the launcher to know the id before boot, which is why minting moved out of the app bundle — and it keeps exit free of awaited work after the terminal is released.

The TUI owns rendering, not wording: it applies `displayText` before its own `palette.muted`, so a hostile `--config` path cannot inject terminal escapes into the exit line. Sanitizing means the launcher cannot embed its own ANSI.

## Alternatives considered

**Keep the keys and add built-in defaults in the app bundle.** Rejected: a default in code survives an overlay, but two ways to state one fact remain, and a config author can still set the key wrong — which is exactly how the stale `process.env.RESUME_SESSION_ID` line disabled resume.

**Merge the app bundle into `apps/cli` and delete the slot entirely.** Rejected here, then [adopted later](../simplification/2026-07-29-shared-base-config-overlays.md) in a form this note did not consider: the composition moved into flat config files (`apps/cli/config/base.cordis.yml` plus a per-surface overlay) rather than into CLI code, so it never entered the `v8 ignore` process-wiring block, and the overlay extension points survive as ordinary row patches. The slot itself was not deleted — it moved to `dsh-agent-loop`, because a launcher fact still cannot travel through a replaceable config key.

**Put the goodbye message on `TuiResumeHost`.** Rejected: an exit line is not a handoff capability, and a host that cannot replace its process may still want to print one. They are independent slots.

**Have the host supply only the command text and let the TUI keep the `To resume this session:` prefix.** Rejected: the TUI would retain resume vocabulary for a string it no longer understands, and meta mode proves the launcher is the only component that knows what the command should say.

**Let the TUI keep suppressing the line until the session is durably persisted.** Rejected: that check is why the exit path queried persistence and swallowed listing failures. A plain string cannot consult persistence, and misuse now fails loud through `agent-loop/config-start-failed` rather than silently resuming nothing.

**A callback (`goodbyeMessage(agent)`) so the host could decide at exit time.** Rejected: it restores async work after `ui.stop()`, reintroducing a hang risk during teardown for a string that is already knowable at boot.

## Consequences

- Removing two published `Config` keys is a breaking config change: a stale config naming either now fails schema validation at boot instead of degrading silently. Intended, and acceptable pre-release.
- `TuiResumeHost` is unchanged, but `TuiRuntime` gains `goodbyeMessage`; `apps/cli` is the only provider.
- The exit line prints even for a session with no log (launch, quit immediately). Using it then fails loud rather than starting a surprise session. This is the deliberate cost of dropping the persistence check.
- `dsh-tui` no longer reads `sessionPersistence` at all: `currentResumeCommand`, `listWorkspaceSessions`, and its swallowed-error path are deleted, and the `/resume` selector's `sessionQuery` reads are now the only session discovery in the TUI.
- The launcher mints session ids for its own app, so a non-CLI host that provides no slot keeps the bundle's own minting.

## Testing

`packages/ui/tui/tests/tui.spec.ts` pins the printed line, the absent-slot silence, and escape sanitization of a hostile message; the former two exit-suppression tests are replaced, since suppression is the behavior this change removes. `packages/core/agent-loop/tests/` drives the identity slot for the resume, launcher-minted, and no-slot cases.

The load-bearing coverage is `apps/cli/tests/tui-keyless-smoke.e2e.ts`, which launches the real `apps/cli/src/bin.ts` in a PTY: one test asserts the exit line carries `--config`, and a regression test seeds a personal `config.yaml` that replaces the entire `agent-loop` config block and asserts the line still prints — encoding "an overlay cannot drop resume" as an executed contract rather than a comment.

Verified live in tmux against the real personal overlay: the defect reproduced on unmodified staging (requested id ignored, fresh id in the banner), and on this branch the same overlay yields a printed exit line, a `--resume` that restores the prior turn, and a `/resume` selector marking the session `current · live · persisted`. A wrong id now fails loud.
