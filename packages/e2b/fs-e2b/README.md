# @deepseek-ai/dsh-fs-e2b

English | [中文](README.zh.md)

E2B implementation of the [`@deepseek-ai/dsh-fs`](../../fs/fs/README.md) provider seam. It has no config: load [`@deepseek-ai/dsh-e2b`](../e2b/README.md) first, then this service in place of `dsh-fs-local`. The provider uses the owner's remote cwd and SDK handle, so file tools observe the same world as E2B-backed Bash processes.

## Behavior

- **Remote identity and metadata** — relative paths resolve as POSIX paths against the caller cwd or `ctx.e2b.cwd`; `realpath -m` supplies canonical target identity without requiring the final file to exist. `stat`, no-follow `lstat`, and stable one-level directory listings project E2B metadata into the filesystem seam. Versions are opaque hashes of E2B metadata plus a per-write extended attribute.
- **UTF-8 reads** — whole reads and streamed reads preserve cross-chunk decoding, reject invalid UTF-8, and use the seam's 8192-byte NUL sample for binary detection. The model-facing tool still owns size selection and line windowing.
- **Atomic mutations** — writes upload a mode-`0600` temporary sibling, preserve an existing file's POSIX mode, and publish through same-directory Linux `mv -f`. E2B creates missing parent directories. Literal edits LF-normalize for matching, restore dominant CRLF storage, and serialize mutations per canonical target within the host process. Optional create/version guards keep the base seam's observed-state semantics.
- **Failures and cancellation** — E2B not-found, permission, abort, and other controller failures map to the existing `FsError` vocabulary. Cancellation is best-effort at SDK request boundaries; a successful rename is the commit point.

The provider does not copy, mount, or reconcile the host workspace. Giving it a host path as `cwd` creates a remote directory with the same spelling only.

## Model Experience

Indirectly, through [`dsh-tool-fs`](../../fs/tool-fs/README.md), which renders remote UTF-8 content, directory results, mutation acknowledgements, and provider errors while E2B identity and transport remain internal.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No host synchronization** — an empty E2B cwd stays empty until a tool, command, template, or external process populates it; local files are neither uploaded nor reflected back.
- **Mutation coordination is host-process-local** — another harness connection or remote command can race the adapter; version guards detect only metadata changes represented by E2B.
- **Whole-file mutation costs remain** — overwrite diffs and literal edits read complete files into host memory, and every operation incurs E2B controller latency.
- **Custom templates must support the used Linux and envd features** — `realpath`, `chmod`, `mv`, same-filesystem POSIX rename, streaming reads, and file metadata extended attributes are required; unsupported templates fail rather than degrade silently.
