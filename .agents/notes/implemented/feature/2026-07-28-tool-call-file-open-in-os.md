# Agent Note: Tool-call file open in OS

Status: implemented

English | [中文](2026-07-28-tool-call-file-open-in-os.zh.md)

## Problem

Chat tool rows treated the whole summary line as a click target that opened the right-hand details panel, with a hover background on the row. For filesystem tools the useful action is opening the mentioned file in the operating system's default application, not inspecting the raw tool payload in a sidebar.

## Decision

File-tool path summaries (`read` / `write` / `edit` args carrying `path` or `file_path`) render as hover-underline links with a pointer cursor. Clicking the path calls `host.openPath` through `WorkspacesService.openPath`, resolving relative paths against the session cwd. File-link rows disable args expand (leading icon is inert); whole-row click, row hover fill, and the click-to-open-details gesture are removed from tool rows (including bash and todo registrations). The details panel and its inject surface remain for programmatic selection; rows no longer drive them.

`host.openPath` is a privileged unary RPC accepted only from loopback, same-origin browser requests (same carrier guard as `host.pickDirectory`). Platform adapters open without a shell: `open` on macOS, PowerShell `Invoke-Item` on Windows, `xdg-open` on Linux. The opener is injectable for tests. URL-only read args (`web_fetch`) are not file links.

## Alternatives considered

- Keep row-click details and add a separate file affordance — rejected; the product ask replaces the row gesture with the file link.
- Open files inside an in-app preview — rejected; the ask is the OS default application.
- Reuse `host.pickDirectory`'s timeout exemption — unnecessary; path open hand-off completes quickly under the normal unary deadline.

## Consequences

Clicking a file path in a tool row opens that path on the host. Non-file tool rows are inert summaries (expand toggles remain where the row already supported them). Remote or non-loopback clients cannot invoke `host.openPath`.

## Risks

- Linux hosts without `xdg-open` fail the RPC; the chat row stays silent while the host returns an internal error.
- Relative paths without a session cwd are forwarded verbatim and may fail on the host.
