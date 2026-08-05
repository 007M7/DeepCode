# Typert

[English](README.md) | 中文

Typert 将源代码分析、运行时存储和 Loader 发现机制拆分为彼此独立的包。

| 包 | 职责 | Cordis 键 |
|---|---|---|
| [`registry/`](registry/README.md) | 运行时包反射和实时 Zod schema 注册表 | `ctx.typert` |
| [`loader/`](loader/README.md) | 发现 Loader 条目并注册所生成的宿主产物 | 使用 `ctx.loader`、`ctx.typert` |
| [`generator/`](generator/README.md) | 与编译器无关的类型分析和产物生成 | 构建时库 |
