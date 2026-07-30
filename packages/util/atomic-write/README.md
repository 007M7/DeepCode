# dsh-atomic-write

English | [中文](README.zh.md)

Zero-dependency atomic file replacement shared by file-backed stores that must never leave partial, symlink-hijacked, or wider-than-intended content on disk — the user-settings document (`dsh-settings-local`) and the credentials store (`dsh-credentials-local`).

## Surface

```ts
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const text: string
declare const render: (previous: string) => string

await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })

// Read-modify-write against the same file from several processes.
await withFileLock('/home/u/.dsh/settings.yaml', async () => {
  await writeFileAtomic('/home/u/.dsh/settings.yaml', render(text), { mode: 0o600 })
})
```

`writeFileAtomic` commits one already-rendered string. The contract, in the order failures would exploit it:

- **Exclusive-create temp** (`wx`, random suffix): the open refuses to follow a symlink planted at a guessable temp path.
- **The fresh inode carries `mode` through the rename**: replacing a wider-permission file narrows it without a chmod race. `mode` is required so the permission decision stays visible at every call site (subject to the process umask, like every fresh inode).
- **`rename` replaces a symlinked target itself**, never writing through to its referent.
- **Same-directory sibling** keeps the rename on one filesystem, so the swap stays atomic.
- Parent directories are created; on any failure the temp is removed and the failure rethrown; readers observe either the old or the new complete content.

`withFileLock` serializes the writers of one file across processes, for the read-render-commit cycles a bare atomic commit cannot make safe on its own. The lock is a `wx`-created `<filename>.lock` sibling, so readers never contend; waiters back off exponentially and fail with a timeout rather than block forever. A lock older than the stale age is treated as a crashed holder and broken — see [Known Limitations and Deferred Work](#known-limitations-and-deferred-work) for what that costs.

## Model Experience

None, as this is a pure filesystem primitive; nothing here reaches a model request.

#### KV Cache effect

None; nothing here enters a request prefix.

## Known Limitations and Deferred Work

- **Atomic, not durable** — no `fsync` of the file or its directory, so after a crash the rename may be observed unwound. The file-backed stores here re-read and republish on boot, keeping durability the caller's policy.
- **String content only** — no `Buffer` or stream form until a consumer needs one.
- **The lock takes over by age, not by ownership** (`TODO(settings-lock-ownership)`) — a holder slower than the stale age has its lock broken by a waiter, and release unlinks the path unconditionally, so a slow writer can remove a successor's lock. Two writers can then overlap and one cycle's result be lost. The stale age is set well above any write this repo performs, so the exposure is a paused or swapped-out process; ownership-safe acquisition and release is the fix.
