# RFC：将 Node LTS 引擎下限提升至 22.19

Status: implemented

[English](2026-07-06-node-engine-floor.md) | 中文

## 问题

根 `engines.node` 范围中的 Node 22 分支是对已安装工作区的契约，而不仅仅是 harness 源码直接调用的运行时 API 的契约。该分支的下限不得低于工作区在该分支上安装的依赖所声明的 package `engines.node`；否则 `pnpm install --engine-strict` 会在一个被宣传的 LTS 版本上失败，而非严格模式的安装则会在依赖所支持的运行时范围之外运行。

## 决策

将 `engines.node` 设为 `^22.19.0 || >=24.0.0`，并在 keyless CI 兼容性矩阵中测试 `['22.19', 24, 26]`。每个矩阵分支都运行 TypeScript 类型检查加一次 keyless 的源码模式 worker 冒烟测试，因此引擎下限同时通过完整的源码类型检查和真实的未构建运行时路径得到验证。真实 API 的 e2e 工作流保持在 Node 24 上运行，因为它验证的是 API 集成而非运行时下限。

两项 Node 特性决定了源码运行时的下限：

- **`node:sqlite`**：`packages/session-persistence/session-persistence-sqlite` 在顶层执行 `import { DatabaseSync } from 'node:sqlite'`。该模块在 **22.13**（LTS）和 **23.4**（Current）取消了 `--experimental-sqlite` flag 要求；在此之前，导入它会在加载时抛出异常。
- **原生 TypeScript 类型剥离**：`packages/examples/stdio-demo/tests/built-bin.e2e.ts` 冒烟测试在纯 `node`（无 tsx）下启动已发布的 `lib/bin.js`，并加载示例的 `.ts` 插件（`mock-llm.ts`、`echo-tool.ts`）。类型剥离从 **22.18**（LTS）和 **23.6**（Current）起成为默认行为；在此之前需要 `--experimental-strip-types`。

这些源码特性在 22.x 线上于 **22.18** 全部就绪，但已安装的 Pi 适配器依赖将宣传的 LTS 下限进一步抬高。`@deepseek-ai/dsh-llm-pi-ai` 依赖 `@earendil-works/pi-ai@0.79.3`，后者的 package 声明 `engines.node >=22.19.0`，因此 LTS 下限为 **22.19**。24.x 分支保持 `>=24.0.0`。该不连续范围完全排除 Node 23：Node 23.0–23.5 仍有至少一项源码特性需要 flag，而 23 线是非 LTS/已 EOL，宣传 `>=23.6` 只会增加一个已死的发布线和一个不应被任何部署使用的 CI 分支。

`@types/node` 继续固定在 22.x 线（`^22.20.0`），以匹配 LTS 支持线：如果使用了 Node 23+/24+/25+ 才有的 API，`tsc` 会在所有机器和类型检查门禁中报错，而不是编译通过后存活到只有下限矩阵分支才能捕获的运行时失败。整棵树目前在 Node 22 类型表面上类型检查全部通过，因此这个固定没有代价。

## 后果

- 宣传的 LTS 分支不再低于 Pi 适配器依赖的下限。
- CI 用 Node 22.19 直接验证 Node 22 LTS 下限，Node 24 分支保持 `node: 24`，Node 26 用于下一个偶数线；每个分支都对源码图做类型检查，并实际启动未构建的工作流 worker。
- built-bin 冒烟测试不需要版本条件 flag：在 22.19 上类型剥离已是默认行为，因此测试保持其文档记录的纯 `node lib/bin.js` 路径。
- 未来如有依赖或源码 API 抬高运行时下限，必须在同一个变更中同步修改 `engines.node`、兼容性矩阵与本 RFC。

## 曾考虑的替代方案

- **保持 `^22.18.0 || >=24.0.0`。** 否决：它宣传的 LTS 版本低于 Pi 适配器依赖的下限。`@earendil-works/pi-ai@0.79.3` 要求 `>=22.19.0`。
- **降级或固定 `@earendil-works/pi-ai` 以保留 22.18 的宣传范围。** 否决：当前的 Pi 适配器依赖是工作区的预期组成部分，且 22.19 仍在 Node 22 LTS 线内。
- **下限设为 `>=22.13`（`node:sqlite` 边界），在 22.13–22.17 的 built-bin 冒烟测试中加 `--experimental-strip-types`。** 否决：为一个窄范围增加版本条件测试 flag，并将对实验性 flag 的依赖伪装成正式支持。Pi 适配器依赖已经要求更高的 LTS 下限。
- **开放式 `>=22.19`。** 否决：它宣传支持 Node 23.0–23.5，而在这些版本上 `node:sqlite`（直到 23.4）或类型剥离（直到 23.6）仍需 flag。
- **包含 Node 23.6+（`^22.19.0 || >=23.6.0`）。** 否决：23.6+ 确实能无 flag 运行两项源码特性，但 Node 23 已 end-of-life；宣传一个已死的发布线只会增加一个范围项和一个 CI 分支，用于一个不应被任何部署使用的运行时。
- **矩阵用 `[22, 24, 26]` 而非固定 `22.19`。** 否决：浮动的主版本号条目会随时间上漂，悄然不再验证所声明的 LTS 下限。
- **让 `@types/node` 超前于下限（`^25`）。** 否决：类型定义超前于运行时下限会让仅 Node 24/25 才有的 API 编译通过，仅在 22.x 上运行时才失败。将 `@types/node` 固定在 22.x 线上，会把这种情况变成所有环境下的编译错误。
