# Agent Note: A capability-discriminated directory-picker seam for the web-GUI host

Status: implemented

English | [中文](2026-07-28-directory-picker-capability-seam.zh.md)

## Problem

The web GUI's "Open local folder" flow was hardwired to one interaction: `host.pickDirectory` invoked a native OS chooser compiled into `dsh-host-apiproxy` (private module, test-only injection seam). That shape cannot serve remote deployments — no OS dialog reaches a browser on another machine — and the planned in-app directory browser (Figma `Harness` 802-56979) needs listing/creation primitives, which are a different interaction contract, not a different implementation of the same one. Swapping interactions required editing gateway source, against the repo's everything-is-a-plugin stance.

## Decision

A three-package capability seam in `packages/host/` — `directory-picker` (interface), `directory-picker-dialog`, `directory-picker-browse` (backends) — with one contract method: `capability()` returns a **discriminated union**, `{ kind: 'dialog', pick(signal) }` or `{ kind: 'browse', list(path?), createDirectory(path, name) }`. The gateway (`dsh-host-apiproxy`) injects `directoryPicker`, advertises the kind through `host.describe.directoryPicker`, serves the matching RPCs, and answers `directory-picker-unavailable` for the other kind; the client branches on the advertised kind and hides the affordance for unknown kinds (merge-extensible default). Composition (`cordis.yml`) is the swap point; the union is discriminated because the backends differ in *interaction shape* — flattening them into one method set would force every backend to fake the other's shape.

Placement and policy rulings folded into this decision:

- **Not the `ctx.fs` seam.** `packages/fs/` is the model/session-facing storage stack (policy events, sandbox-swappable backends). Riding it would couple GUI browsing to the model's confinement backend — swapping `fs-sandbox` for the model must never change GUI behavior — and OS facts (home anchoring, hidden conventions) are not storage primitives. The picker seam stays presentation-free and model-free; `packages/host/` is its consumer-domain home.
- **Dependency survey (hand-roll vs adopt).** Node's stdlib *is* the maintained cross-platform OS layer (`readdir(withFileTypes)`, `homedir`, path semantics); surveyed alternatives fail the dependency bar — file-manager packages (`node-file-manager`, `files-and-folders`, Syncfusion's provider) are whole HTTP apps (fit), drive-letter helpers (`drivelist` native addon, `windows-drive-letters` ~7y stale) fail health/proportionality. The browse backend is a thin adapter over stdlib.
- **Hidden entries: return-and-flag.** The host stamps `hidden` (POSIX dot convention) and returns everything; the client filters. Display policy stays client-side, and the planned show-hidden toggle becomes a client-only change. Windows' `FILE_ATTRIBUTE_HIDDEN` is not exposed by dirents — documented limitation until a native probe pays for itself.
- **Symlinks: follow for enterability.** `stat` probes symlinks (broken/cyclic → skipped); crumbs keep the logical path the operator navigated, and `workspace.create` already canonicalizes via realpath at adoption.
- **Whole-filesystem scope, no roots config.** `workspace.create` accepts arbitrary paths and the API serves bash-driving methods, so a browse root would be UX scoping, not a boundary; configurability without a consumer fails the evidence bar. Deferred until a deployment needs it.
- **The dialog backend stays.** Plugin-form was the point: multiple providers can serve the seam (an Electron shell would provide `dialog` natively). The backend names changed from mechanism (`native`/`local` — both run locally) to interaction (`-dialog`/`-browse`).

## Alternatives considered

- **Extend `ctx.fs` with browse methods.** Rejected: authority-domain coupling above; also a listing-for-display contract (hidden flags, crumbs, home anchor) does not belong on a storage seam.
- **One uniform seam method set (`pick(): path`).** Rejected: an in-app browser cannot be served behind a single host-side call — the browsing loop lives in the client and needs primitives on the wire; the dialog cannot implement primitives. The interaction difference is irreducible, hence the discriminant.
- **Direct stdlib calls inside apiproxy (no seam).** Rejected: keeps the gateway the only swap point (source edits), loses fixture/test backends, and contradicts the plugin doctrine that motivated the work.
- **Adopting a file-manager/drive-enumeration dependency.** Rejected per the survey above; recorded here as the dependency policy requires.

## Consequences

- `cordis.yml` chooses the interaction; `apps/cli` mounts `-browse` (the in-app browser is the shipped default), the GUI branches on `describe`, and `-dialog` stays a composable alternative for host-display deployments.
- The wire gains `host.listDirectory`/`host.createDirectory`, four error codes, and the `describe.directoryPicker` field; the connection fixture serves a deterministic browse tree for keyless assembled tests.
- A future interaction (or an Electron `dialog` provider) is one backend package plus a client branch — no gateway surgery.
- `ApiProxyDefaults.pickDirectory` (test-only injection) is gone; tests provide a stub `ctx.directoryPicker` like any other service.
