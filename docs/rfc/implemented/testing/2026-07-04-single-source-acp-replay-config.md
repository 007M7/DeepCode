# RFC: Single-source the acp-agent replay config

Status: implemented

## Problem

`examples/acp-agent` shipped two hand-maintained configs: `cordis.yml` (the live tree) and a `cordis.snapshot.yml` that mirrored it entry-for-entry with only the llm backend swapped — stripped of comments, the entire difference was the eight-line `llm-deepseek` stanza versus the two-line `llm-replay` stanza. Every app-shape change had to be made twice, and nothing gated the symmetry: if the copies drifted, the snapshot tier would silently exercise a different app than the one that ships — the ["green units, broken product" class of gap](../../../postmortem/0001-acp-default-export-drops-inject.md) the snapshot tier exists to close, reintroduced one level up, with reviewer vigilance as the only defense.

## Decision

`cordis.snapshot.yml` is a declarative overlay, not a copy: its single entry mounts `@cordisjs/plugin-include` on `./cordis.yml` with `patches` that disable the `llm-deepseek` entry (matched by id AND asserted by `name`, so a reused id can never disable the wrong plugin) and insert the `llm-replay` entry ([the vendored include plugin](../../../../vendor/include/src/index.ts)'s patch mechanism: by-id overrides with an optional name assertion, plus top-level inserts). Every other entry — the app, the bash executor, the fs/subagent/todo tools, both hook bridges, the system prompt — is the live tree itself, loaded through the include, so replay exercises exactly what ships and an app-shape change lands once. The `dsh-acp-agent` bin is untouched (it still just selects this file for `DSH_SNAPSHOT=replay`); recording still boots `cordis.yml` directly; the bin's `assertEntriesLoaded` guard tolerates the disabled entry by design (a disabled entry is the one legitimate fiber-less state).

One vendored-plugin fact the overlay depends on, deliberately: the include applies `patches` when it loads the file — its `refresh()`/`internal/update` paths re-read without re-patching — which is exactly enough for a one-shot replay boot (the replay app loads no `hmr` and nothing rewrites the config mid-run). The snapshot suite is the proof: all scenarios pass unchanged on the overlay, byte-identical goldens included.

## Alternatives considered

### Why not the alternatives?

Keeping the full twin with a symmetry verify-gate was the recorded fallback — it would have removed the silent-drift class but kept a 125-line near-copy whose only content was one entry's difference, growing with every plugin the app gains. A bin-side swap (parse the config, replace the entry, delete the file) would have put YAML surgery inside a published artifact and moved the replay delta out of sight; the overlay keeps the delta declarative, readable, and next to the base config — the teaching value the twin's defenders actually wanted.

## Consequences

- A plugin added to `cordis.yml` is in the replay tree with no second edit; the drift class is structurally gone rather than gated.
- The overlay depends on entries carrying stable `id:`s. The `name` assertion on the disable patch guards mis-targeting (a reused id skips the patch instead of disabling the wrong plugin). An id RENAME degrades the patch to a skip whose warning needs a logger the replay app deliberately lacks — the observable result is a futile keyless `llm-deepseek` entry alongside `llm-replay`, with replay output still correct (`llm-replay` owns the stream short-circuit); config rot for review to catch, not wrong snapshots. A top-level insert whose id collides with an existing entry resolves last-wins through the loader's id map — the current config has no collision, and a new patch line is where one would be introduced.
- If a future replay tree needs a second divergence (another backend swapped), it is one more patch line, not a second fork of the file.
