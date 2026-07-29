# @deepseek-ai/dsh-source-guard

English | [中文](README.zh.md)

An enforcement gate, not a model-facing tool: it never appears in the tool list and adds exactly one behavior — it denies a `write` or `edit` whose target sits inside the dsh checkout the running harness was launched from, on that checkout's own branch, until the calling session's durable log shows a successful load of the `dsh-customize` skill. That skill requires personal changes to be implemented in a task worktree and integrated under the staging lock; this plugin turns its central rule ("do not edit the personal staging checkout directly") from prompt guidance into a boundary the model cannot cross by forgetting.

## Config

```yaml
- id: source-guard
  name: '@deepseek-ai/dsh-source-guard'
  config:
    requiredSkill: dsh-customize          # default; the skill whose load lifts the denial
    tools: [write, edit]                  # default; the gated tool names
    protectedCheckout: /path/to/checkout  # defaults to this module's own location
```

Every field fails loud at plugin load: an empty `tools` list, a blank `requiredSkill`, or a relative `protectedCheckout` throws, never a silent fall-back.

`protectedCheckout` names a path inside the checkout to guard, and its worktree supplies BOTH protected identities: the repository and the exact branch. Its default is this module's own file, which resolves the checkout the running harness was launched from — the live deployment, whatever its branch is named. Nothing about the branch is configured or pattern-matched, so a maintainer whose staging branch follows no naming convention is protected identically. A harness running from an installed copy resolves a different repository, or none, and therefore guards nothing; the rule is meaningless outside a source checkout.

The shipped TUI composition (`examples/tui-agent/cordis.yml`) loads this plugin with defaults. It is inert for anyone whose workspace is not the launcher's own checkout, so an ordinary project sees no change.

## Which paths are protected

Protection is decided by git identity read from files — `.git`, its `gitdir:` pointer, and `HEAD` — never by path prefix and never by running `git`. Prefix matching would be wrong here: the task worktrees the skill prescribes live *inside* the staging tree, at `<staging>/.worktrees/...`, and are exactly where edits belong.

Resolution walks OUTWARD from the target and stops at the first enclosing worktree, so it reports the INNERMOST one. Denial needs that worktree to match the launcher's on BOTH identities: the same shared git directory and the same branch. A task worktree nested under the protected tree answers with its own task branch and passes; the launcher's own tree answers with the launcher's branch and is denied. Repository identity is compared on symlink-resolved paths, so two routes to one repository — a session cwd under `/var/...` and a configured path under `/private/var/...` on macOS — match rather than falling open.

Requiring the exact branch, not a name pattern, keeps the gate on the live deployment only. A stale sibling checkout left by an earlier install shares the repository but runs no launcher, so the workflow rule does not apply to it and it stays editable.

A `gitdir:` pointer may be absolute (what `git worktree add` writes) or relative, which git resolves against the worktree directory holding it; both resolve here. A relative `file_path` resolves against the calling session's workspace, exactly as the filesystem tools resolve it, so it is not an unguarded route to a protected file.

The gate is deliberately narrow:

- **`read` is never gated.** Inspecting the staging checkout violates nothing, so only mutating tools are candidates.
- **`bash` is not gated.** Reliably classifying mutating shell commands is out of scope, so a determined model can still change staging through a shell.
- **Calls without an agent are allowed.** A direct `ctx.tools.execute()` caller has no session to replay and no model to correct.
- **Unresolvable git state fails OPEN.** A path outside any worktree, a detached HEAD on either side, a different repository or branch, a malformed `.git` pointer, or unreadable metadata all leave the call to the rest of the chain. A gate that blocked every write whenever git identity was unavailable would cause more harm than the violation it prevents.
- **An unresolvable target is not judged.** An empty `file_path`, a non-string one, or a relative one in a session that names no workspace leaves the call to the tool's own validation.

Worktree identity is cached per target directory for the plugin's lifetime, so repeated writes in one directory read git metadata once; a mid-session branch switch is therefore not observed.

## How the denial lifts

Satisfaction is replayed from the session's durable log: a `tool/call` naming the `skill` tool whose arguments parse to `{name: <requiredSkill>}`, paired by call id with a non-error `tool/result`. Because the log is the only state, satisfaction survives a session resume — a resumed session that already loaded the skill is not asked again. A failed load, a differently-named skill, and malformed argument JSON all leave the denial in place.

Satisfaction is per session, so a subagent with its own session must load the skill itself.

## Enforcement point

The gate is a `tools/pre-execute` listener returning `{kind: 'deny', reason}`, so the call never dispatches and the file is never touched. It delegates via `next()` in every non-violating case. Denial — not an advisory reminder — is the point: an advisory nudge leaves the violation committed, and `ask` degrades to denial in a composition without approval support.

## Testing

Unit suites drive a real agent loop against a mock adapter over real git-metadata fixtures — a staging worktree, a task worktree nested inside it, a plain clone, a foreign repository on a staging-named branch, a detached HEAD, absolute and relative `gitdir:` pointers, a symlinked route to the same repository, and unreadable metadata — to per-file 100%. The assembled-run evidence is the Loader-composition smoke (`tests/loader-composition.e2e.ts`): it boots a real headless app over `examples/headless-agent/tests/fixtures/guard/source-guard/cordis.yml`, seeds a staging worktree in a temporary cwd, and asserts the tool result is an error carrying the exact denial while the targeted file keeps its original bytes.

## Model Experience

### Denied filesystem call

#### What the model sees

A gated call into a protected worktree without the required skill loaded returns an error result carrying exactly the text below. No prompt section, tool schema, or successful-call text is added, and an allowed call is indistinguishable from one made without this plugin.

##### Denial result

```markdown
Error: Editing "<path>" directly is not allowed: it is inside the dsh checkout this session is running from, on branch <branch>. Load the <requiredSkill> skill first and follow it — implement in a task worktree, then integrate under the staging lock.
```

#### Token effect

Zero tokens while no denial occurs. A denial adds its small retained error result and avoids the success payload the call would have produced.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **`bash` is ungated** — the guard is a boundary for the filesystem tools only; a shell command can still mutate a protected worktree.
- **Worktree identity is cached per directory for the plugin's lifetime** — switching a protected worktree's branch mid-session does not change decisions until the next load, on either the target or the launcher side.
- **Only the launcher's own checkout is protected** — a stale sibling checkout of the same repository stays editable, deliberately; run `dsh` from it to protect it.
- **Disarmed outside a source checkout** — a harness running from an installed copy protects nothing unless `protectedCheckout` names a real checkout explicitly.
- **Satisfaction is per session** — a subagent's session must load the skill itself; a parent's load does not carry over.
- **Fail-open on unresolvable git state** — a broken or unreadable `.git` means no protection, chosen deliberately over blocking every edit.
- **One skill lifts the whole gate for the session** — loading it does not verify the workflow was actually followed, only that the instructions were read.
