# Agent Note: Web `/export` shares the streamed Session ZIP download

Status: implemented

English | [中文](2026-08-11-web-export-command-and-dialog.zh.md)

## Problem

Session export needs a stable Session-level visible action and an equivalent slash-command path. A second backend reader or Host-path writer would duplicate the download implementation and introduce platform-specific file-permission and path-reveal problems.

## Decision

`@deepseek-ai/dsh-session-export` registers a Web-only `/export` human command and provides the browser `ctx.sessionExport` controller. The command records an ordinary `command/run` and `command/done`; after `command.execute` returns a successful result, `dsh-client-ui-command` emits a local acknowledgment that asks this browser's controller to download ApiProxy's existing `GET /api/session.export` ZIP. Other clients render the broadcast command nodes without repeating the browser side effect. The 111×32 `Session log` capsule in the Session Header calls that controller directly. Both paths therefore use the same Host endpoint, browser save operation, in-flight state, error handling, and Modal.

The Header contribution occupies the right-aligned `conversation.session.header.utilities` list and renders the `Session log` text capsule with its trailing download icon plus the shared Modal. The title-adjacent `conversation.session.header.actions` list continues to own mode, Subagent, and Task entries, so mounting Session export does not reorder or move them. The export contribution does not observe Session history. A per-Session controller collapses concurrent gestures, aborts active fetches when its plugin disposes, ignores late requests after disposal, and preserves a user's closed state when the request later completes.

The ZIP endpoint and persistence `readRaw` capability remain owned by `dsh-host-apiproxy` and the persistence package. The endpoint flushes a live root Session before reading its artifact, so the local acknowledgment cannot race ahead of durable command lifecycle rows. This package does not serialize Session events, write Host files, deliver Host paths, or implement SQLite fallback.

The package compiles its Host command and invariant through `tsconfig.host.json`, while `tsconfig.client.json` owns the browser controller, Header action, Modal, and their face-named tests. The repository Host and Client aggregates reference only the matching project, so their incompatible Cordis `Context` merges never enter one TypeScript program.

## Alternatives considered

**Put the visible action in Trajectory.** Rejected because export is a Session-level operation and must remain discoverable without opening a diagnostic view.

**Write a Host-side JSONL file from `/export`.** Rejected because it would diverge from the descendant-and-attachment ZIP, require Windows ACL handling, and return a Host path that may be meaningless to a remote browser.

**Keep both Header and Trajectory buttons.** Rejected because two visible controls for the same Session operation create duplicate ownership and inconsistent placement.

## Consequences

The Header action and `/export` download the same ZIP and show the same feedback. An executed command remains visible in the durable transcript without creating a model turn. Deployments whose persistence backend has no raw per-Session artifact receive the endpoint's existing failure; SQLite support remains separate work. Command availability before a Session's first turn is separate work.
