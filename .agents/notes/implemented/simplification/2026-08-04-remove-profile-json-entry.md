# Agent Note: Removing the profile-json config entry

Status: implemented

English | [中文](2026-08-04-remove-profile-json-entry.zh.md)

## Problem

`./.dsh-tmp-profile/config.json` was the user-configuration plane of the [web config-tree boot](../architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md): a read-only JSON object under the invoking directory, mapped by a static `PROFILE_MAPPINGS` table onto three fields across two rows. Its write path and its relocation to the Harness home were recorded there as deferrals, and neither arrived. Nothing in the product ever created or edited the file, no test exercised it, and no user documentation named it — the format existed only as a reader.

Meanwhile the fields it mapped acquired owners elsewhere. `provider` and `model` are the api-gateway's default route for created and resumed agents, which a session's own picker overrides per agent; `persistenceRoot` is an assembly fact of the shipped composition. Typed user preferences became `$DSH_HOME/settings.yaml` under the [user-settings seam](../architecture/2026-07-28-user-settings-seam.md). What remained was a third user-configuration format, anchored to the invoking directory and behind a hand-maintained mapping table, that nothing wrote.

## Decision

`PROFILE_DIR`, `PROFILE_FILE`, `ProfileMapping`, `PROFILE_MAPPINGS`, and `readProfile()` are deleted along with the patch source that consumed them. `AppCLIEntry` composes its patches from CLI flags and the resolved frontend `distIndex` only; the layers around it — shipped base, surface overlay, and the `--config` overlay — are unchanged.

A `.dsh-tmp-profile/config.json` on disk is now ignored completely. There is no migration, no replacement format, and no deprecation diagnostic: the file never had a producer, so there is no installed base to carry forward, and the [pre-release stance](../../../../AGENTS.md) rejects compatibility shims.

## Alternatives considered

**Keep the reader until typed settings own `provider`/`model`.** Rejected because the gap is not real: with no writer, the file gave users no way to pin a default route either, so keeping it preserves an unproduced format rather than a capability.

**Relocate it to `$DSH_HOME`, the deferral the original note recorded.** Rejected because that deferral assumed the write path would arrive with it. Moving a file nothing writes only moves the dead entry, and the Harness home already has an owner for typed user preferences.

**Report the file through a deprecation diagnostic when it exists.** Rejected because a diagnostic for a format the product never produced would advertise it to users who have never seen it.

## Consequences

- Given up: no file-based way to pin `provider`, `model`, or `persistenceRoot` without editing yml or passing `--config`. A persistent default route needs a typed settings namespace owned by whoever creates sessions; `persistenceRoot` stays an assembly fact.
- Bought: one fewer user-configuration format, one less input anchored to the invoking directory, and a patch composition whose only remaining sources are CLI flags and an assembly fact — the fail-loud mapping table goes with it.
- The [web config-tree boot note](../architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md) is only partially superseded: its composition, boot-glue, transport, and export decisions stand. Both notes stay cross-linked, and its profile facts were rewritten in place.
- Absence is verified by repo-wide search: `.dsh-tmp-profile`, `PROFILE_MAPPINGS`, and `readProfile` have no remaining match.
