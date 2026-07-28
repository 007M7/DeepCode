# Typert

English | [中文](README.zh.md)

Typert separates source analysis, runtime storage, and Loader discovery into independent packages.

| Package | Role | Cordis key |
|---|---|---|
| [`registry/`](registry/README.md) | Runtime package reflection and live Zod schema registry | `ctx.typert` |
| [`loader/`](loader/README.md) | Loader-entry discovery and generated host-artifact registration | consumes `ctx.loader`, `ctx.typert` |
| [`generator/`](generator/README.md) | Compiler-independent type analysis and artifact generation | build-time library |
