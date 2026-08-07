# Agent Note: TSC 优先构建与编译器单一归属

Status: implemented

[English](2026-06-17-ts-build-config.md) | 中文

> 根项目拓扑（即哪个 tsconfig 拥有哪张图）后来改为由一个 solution 根文件统辖两个聚合 program；见[solution 根文件 Agent Note](2026-07-22-tsconfig-solution-root-two-aggregates.md)。本文确定的 TSC 优先流水线保持不变。

## 问题

此前的 TypeScript 构建与类型检查配置存在以下问题：

- `build` 使用 `tsc` 将 `packages/<group>/<pkg>` 和 `vendor/*` 下的 `.ts` 转换为 `.d.ts` 文件，然后使用 `tsdown` 将 `.ts` 转换为打包后的 `.js` 文件。这导致两个工具各自执行 TypeScript 转换。
- `typecheck` 倾向于通过一个根目录的类型检查配置来校验包（package）、vendor 源码、示例、测试和脚本。

目标是让构建与类型检查使用一致的 tsconfig 边界和 TypeScript 解析/转换行为。构建应通过单一编译器和配置生成 `.js`、`.d.ts`、`.js.map` 和 `.d.ts.map`，使发布产物与类型校验保持一致。

验证过程中发现了若干具体的技术问题和可能的路径：

- `tsdown` 使用 `oxc` 进行 TypeScript 转换，其行为与 `tsc` 不同。
    - `tsdown` 输出的打包 `.d.ts` 与 Cordis 内部的相对模块增强（module augmentation）结构冲突。
    - tsc 的输出受 `allowImportingTsExtensions` 影响，因此需要确保生成的 `.js` 文件不会导入 `.ts` 文件，且生成的 `.d.ts` 文件保留 NodeNext/Node16 接受的显式相对说明符。为此，包内相对导入在 TypeScript 源码中使用显式 `.ts` 说明符，由 `rewriteRelativeImportExtensions` 在输出的 JS 中将其重写为 `.js`。
    - `tsdown` 输出的打包 `.js` 与 `tsc -b` 逐文件输出的 `.js` 行为不同，例如装饰器转换行为。
- `vendor/*/src`、示例、测试和脚本无法全部以 plain-include 方式纳入一个根目录的严格程序。
    - 在根目录严格配置下直接对 `vendor/*/src` 做类型检查，会触发大量不属于本项目所有权范围的类型错误。
    - `packages/*/*` 对 `vendor` 的包依赖解析到 `vendor/*/lib`，以适应不同的 tsconfig 严格度。


## 决策

包内相对导入使用显式 `.ts` 说明符。

`pnpm run build` 是两阶段构建：

- 阶段 1：在根 solution 上执行 `tsc -b`，将逐模块的 `.js`、声明文件 `.d.ts`、JS sourcemap `.js.map` 和声明 sourcemap `.d.ts.map` 输出到各包的 `lib/types`。这是权威的 TypeScript 编译结果。发布时保留 `.d.ts`；如果包的运行时 export 显式指向该输出树，也会保留其中的 `.js` 文件。`.js.map` 和 `.d.ts.map` 留在本地构建树中。
    - 该图是从根 solution `tsconfig.json` 经两个聚合可达的 project-reference 图（[拓扑](2026-07-22-tsconfig-solution-root-two-aggregates.md)），用于校验并输出包/vendor 的构建结果。
- 阶段 2：打包器读取 `lib/types` 下输出的 JS，将打包后的运行时入口写为 `lib/index.js` 或 `lib/index.mjs`（沿用当前行为）。此阶段仅做打包，禁止读取 TypeScript 源码或输出声明文件。

`tsdown` 不再负责 TypeScript 编译或声明文件输出。

`pnpm run typecheck` 运行同一张 `tsc -b` 图。
- 两个聚合（`tsconfig.host.json`、`tsconfig.client.json`）以 `noEmit` 方式检查示例、测试和脚本，并通过 references 校验包/vendor 源码。
- 被引用的包/vendor 项目保持与构建相同的输出行为，因此类型检查会刷新它们的 `lib/types` 输出，而无需使用独立的 no-emit 图。项目特定的严格度变更放在各自的 `packages/*/*/tsconfig.json` 或 `vendor/*/tsconfig.json` 中。
- 两个 no-emit 聚合禁用 `rewriteRelativeImportExtensions`；它们不输出任何文件，且包含跨 project-reference 边界导入 helper 的测试。包/vendor 的 emit 项目保持重写开启。

复合项目将增量构建信息保存在各项目本地的 `lib/` 输出中。`pnpm run clean` 会根据根 TypeScript project-reference 图确定当前有效的输出目录，删除遗留的根目录构建信息，并删除已删除包留下且仅包含已知生成残留的 `packages/*/*` 目录。在删除现有目标前，该命令会解析目标父目录的真实路径；如果解析后的父目录位于仓库之外，则拒绝删除，防止使用符号链接的 project reference 将清理操作重定向到工作副本之外。对于仍有 `package.json` 的每个包，该命令都会保留 `node_modules`；如果不含 `package.json` 的目录中存在未知文件，则拒绝删除。构建不会自动调用 clean，因此常规构建会保留增量状态。

命令编排结构如下：

```sh
pnpm run build:
tsc -b
tsdown

pnpm run verify-node-next-types:
tsx scripts/verify-node-next-types.ts

pnpm run typecheck:
tsc -b

pnpm run clean:
tsx scripts/clean.ts
```

源码模式 demo 通过各自声明的 TypeScript 启动器和根路径映射运行。`dsh` TUI 链使用 Node 原生转换及应用自有的路径 loader，Web demo 在进入同一条 CLI 源码链路前先构建所需产物，其他源码 demo 继续使用 tsx。

## 曾考虑的替代方案

- **继续使用 `tsdown`/oxc 作为 TypeScript 转换器**：oxc 的转换行为与 `tsc` 不同（装饰器转换有差异、打包 JS 与逐文件输出不同），且其打包 `.d.ts` 与 Cordis 内部的相对模块增强结构冲突。
- **用一个根目录严格程序覆盖包、vendor、示例、测试和脚本**：vendor 源码在根目录严格标志下会触发不属于本项目所有权范围的类型错误；带有逐项目严格度的 project references 才是可行的边界。
- **每次构建前都执行清理**：即使工作区布局没有变化，这也会丢弃 `tsc` 和打包器拥有的增量状态。
- **删除所有包级 `node_modules`**：有效的包依赖链接不会导致工作区发现失败，而删除这些链接会使构建清理变成重新安装依赖。

## 后果

构建职责更加清晰：

- `packages/<group>/<pkg>` 和 `vendor/*` 下的每个模块有一份本地 tsconfig，同时服务于构建、类型检查和直接运行源码的工具（如 `dsh` 源码 loader、`tsx` 和 `vitest`）。
- `build` 命令驱动根 solution 图。`tsc -b` 负责可发布的逐模块 `.js` 和 `.d.ts` 输出，打包器仅负责 `lib/index.*`。
    - `lib/types/*.d.ts` 是发布用的声明输出；`.d.ts.map` 只作为本地编译产物保留。
    - `lib/types/*.d.ts` 使用显式 `.ts` 相对说明符，TypeScript 的 NodeNext/Node16 解析器会将其映射到同级的 `.d.ts` 文件。
    - `lib/types/*.js` 通常仅作为打包器输入。只有显式运行时 export 指向该输出树时，才会发布这些文件。
    - `lib/index.*` 是发布用的运行时输出，由打包器（当前为 `tsdown`）生成。
- `pnpm run verify-node-next-types` 扫描构建出的声明文件，检查是否存在缺少文件扩展名的相对说明符，然后以 `moduleResolution: "NodeNext"` 对构建出的 `types`/`exports` 接口进行临时外部 ESM 消费方的类型检查，确保声明说明符的回归在发布前被捕获。
- `typecheck` 命令使用 `tsconfig.json`。示例、测试和脚本由根 no-emit 项目检查，包和 vendor 模块保持与 `build` 相同的输出行为。包和 vendor 源码始终处于 project-reference 边界之后。
- 切换分支或更新工作副本后，如果其中删除了包，贡献者可在重新构建前运行 `pnpm run clean`，删除残留的包目录。不含 `package.json` 的包目录如果存在未知文件，必须手动判定其类别，不能直接删除。

Cordis 的 vendor 副本现在与上游多了一处类型结构差异。在上游同步时，该差异必须被重新应用或明确废弃。
