# Agent Note: Removing the personal composition layer

Status: implemented

English | [中文](2026-08-04-remove-personal-composition-layer.zh.md)

## Problem

`$DSH_HOME/config.yaml` was an implicit composition layer: if the file existed, every `dsh` launch applied an arbitrary Loader patch graph over the shipped tree, and the TUI and Web kept it live through a dedicated HMR watcher. Three costs followed from the implicitness rather than from the capability.

A patch replaces its target row's whole `config`, so a personal file written months ago pins that row to the field set it knew. Every default the shipped tree later adds to that row silently stops applying, and nothing surfaces it short of running `--dump-config`. Applying that on every launch turns a one-time edit into a standing divergence.

It also competed with typed settings for the same values. `llm-deepseek` and `llm-pi-ai` register settings namespaces, and the same fields are reachable by patching their rows — so which one wins is a function of layer order, not of what the value means. That is the ownership ambiguity the [user-settings seam](../architecture/2026-07-28-user-settings-seam.md) exists to remove.

Finally the escape hatch it was supposed to be redundant with did not cover every surface: `dsh -p` rejected `--config`, and so did the `meta` and `upgrade` subcommands of the time. For those surfaces the implicit file was not one composition route among two — it was the only one.

## Decision

The implicit layer is deleted and the explicit one is completed.

**Every booting surface takes `--config`.** `dsh -p` joins the surfaces that already had it, so naming an overlay is available wherever a tree boots. The TUI, `meta`, and `upgrade` were removed in parallel by the [explicit-config entrypoint](2026-08-03-explicit-config-dsh-entrypoint.md), which also deleted the whole-tree `--config-replace` path; what remains of this change on that side is headless, which previously rejected the flag and had the implicit file as its only composition route.

**`$DSH_HOME/config.yaml` is not read, watched, or dumped.** `PERSONAL_CONFIG_FILENAME`, `loadPersonalPatches`, `watchPersonalPatches`, and the config-only HMR row mounted for it are deleted. A file left at that path is inert. The Harness home keeps `settings.yaml`, `.credentials.yaml`, and `.env`; an overlay may still live there, but as a path to name, not a layer to discover.

`--config` therefore changes meaning slightly: it used to *replace* the personal overlay, and now it simply *is* the user overlay.

Everyday capabilities keep their owners. Model and provider parameters already belong to the adapters' typed settings namespaces. The `repository-plugins` row ships mounted with an empty list, so a repository Plugin list is a `--config` overlay today and a settings namespace when one lands. MCP servers stay a `--config` composition, which is what [the CLI README](../../../../apps/cli/README.md) now documents.

There is no migration and no deprecation diagnostic: the product is unreleased, and a user who wants the old behavior names the same file (`dsh --config ~/.dsh/config.yaml`), which a shell alias makes permanent.

## Consequences

- Given up: a composition that follows you across launches without being named. Restoring it is an alias, which is the point — the graph is now something a launch declares rather than something the machine holds.
- Given up: live reload of a composition file. Settings and credentials keep their own watchers; a composition change now takes a restart, which is what `--config` already meant for every explicit tree.
- Bought: one composition route instead of two, a shipped tree that cannot be silently pinned to a stale field set, and typed settings as the uncontested owner of the values they declare.
- The [personal-config feature note](../feature/2026-07-20-dsh-cli-personal-config.md) is only partially superseded — the `dsh` CLI it introduced stands — so both notes stay cross-linked and its config-overlay facts were rewritten in place.
- `--dump-config` prints the shipped base, the surface overlay, and any named `--config`; with no flag it prints the shipped composition alone, so the Harness home no longer changes what a dump shows.

## Alternatives considered

**Keep the file but stop watching it.** Rejected: the watcher is the smaller half. The standing cost is that an old patch list silently pins a shipped row on every launch, which a startup-only read preserves exactly.

**Name the overlay from `settings.yaml` (`compositionOverlay: ~/.dsh/my.cordis.yml`).** Rejected, and worth stating because it looks like the best of both: it keeps the runtime property that motivated the removal — every launch applies an arbitrary plugin graph — and only changes the trigger from "file exists" to "field is set". Worse, `settings.yaml` is written by the product's own settings UI, so it would let a settings page edit the composition tree.

**Delete it only after the settings-driven repository and MCP managers exist.** Rejected as an unnecessary dependency once `--config` reached every surface: the managers make those two cases *nicer*, but with the flag available everywhere, nothing is lost by removing the implicit layer first.

**Keep it for `dsh -p` alone, where no flag existed.** Rejected: that is the surface with the strongest case for explicitness. A CI or scripted run should name its composition rather than inherit whatever the machine holds — which is why `-p` gained `--config` here instead.
