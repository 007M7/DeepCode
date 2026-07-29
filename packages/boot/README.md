# boot/ — shared app-bin boot glue

English | [中文](README.zh.md)

The channel-neutral boot library the app bins share. A role-complete single-package group: it belongs to no channel and no assembly — `apps/cli`, the [`scaffold/`](../scaffold/README.md) launcher, and the [`examples/`](../examples/README.md) demo bins all consume it.

| Package | Role | ctx key |
|---|---|---|
| `app-boot/` | Shared boot glue for the app bins: `.env` loading, fail-loud Loader guards, snapshot-aware config resolution, the settle-the-tree boot sequence | (library for the bins) |
