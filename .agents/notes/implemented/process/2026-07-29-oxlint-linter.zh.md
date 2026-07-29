# Agent Note: 使用 Oxlint 作为仓库 linter

Status: implemented

[English](2026-07-29-oxlint-linter.md) | 中文

## 问题

仓库的自有源码需要类型感知的 TypeScript 正确性规则、一致的格式，以及文件内重复逻辑检查。ESLint 通过 JavaScript 解析器、项目服务和多个插件提供这些检查，但在本地迁移基线上，一次无问题的 lint 运行约需 1 分钟，并且需要 8 GiB Node 堆、CI 结果缓存和单独调优的 ESLint 并发度。

不能以提高运行速度为由丢失规则。迁移必须保留严格类型检查预设、仓库覆盖配置、内联抑制指令、@stylistic 修复、SonarJS 检查、host/client TypeScript 隔离和 vendor 排除规则。

## 决策

根目录的 [`.oxlintrc.json`](../../../../.oxlintrc.json) 是仓库 lint 配置的权威来源。`lint` 包（package）脚本、门禁调度器和 CI 使用 Oxlint 进行全仓库及类型感知验证。`lint:fix` 脚本和 lefthook 先调用仅用于格式化的 [`eslint.format.config.mjs`](../../../../eslint.format.config.mjs)，再运行 Oxlint。直接的 `eslint` 和 `@typescript-eslint/parser` 开发依赖仅用于这次不加载项目的格式化流程；该配置不包含正确性规则或类型感知规则。

`options.typeAware` 启用 `oxlint-tsgolint`。其后端始终按文件发现 TypeScript 项目；Oxlint 的 `--tsconfig` 覆盖项会影响导入解析，但类型感知 lint 会忽略它，因此本仓库不设置该选项。该配置显式载入迁移后的严格类型检查规则和仓库覆盖配置，而不启用内容可能发生变化的 Oxlint 宽泛类别。`typescript/no-unnecessary-condition` 仍从 Oxlint 的 nursery 规则集中启用，因为它在迁移前就是仓库强制执行的规则。

Oxlint 的 JavaScript 插件兼容层运行 `@stylistic/eslint-plugin` 和 `eslint-plugin-sonarjs`，从而继续强制执行现有的格式和文件内重复逻辑规则。兼容层会报告 `@stylistic` 违规，但不会执行其修复器，因此仅用于格式化的 ESLint 流程只负责相应的自动修复。自有源码中的抑制指令使用 `oxlint-*` 指令和 `typescript/*` 命名空间；vendor 源码保留其上游指令，因为 Oxlint 会排除 `vendor/**`。

CI 不恢复或保存 lint 结果缓存。`DSH_OXLINT_THREADS` 可以在门禁调度器中将同一上限传给 Oxlint 的 `--threads` 选项和类型感知后端的 `GOMAXPROCS` 环境变量；普通本地运行对两者均采用默认值。Pre-commit 应用仅用于格式化的 ESLint 修复，运行 Oxlint 验证和原生安全修复，并通过 lefthook 重新暂存结果。

## 验证

解决两处分析器差异后，迁移后的配置报告与迁移前一致的自有源码无问题基线：移除了一项冗余测试断言，而 `tsc` 要求的一处结构性类型转换使用了窄范围的 Oxlint 抑制指令。一项已提交的指纹测试会对严重级别和规则名映射进行归一化，再以已删除 ESLint 配置的精确 blob 为基准，对每一项启用的规则及其选项进行深度比较：源码为 88 项对 88 项，示例为 87 项对 87 项，测试为 83 项对 83 项，不存在缺失、多余或发生变化的配对。对 `typescript-eslint@8.61.0` 的评估还确认，`strictTypeChecked` 并未启用 `@typescript-eslint/no-empty-function`；已删除、仅用于测试的 `off` 条目不起作用。

一项可执行契约测试会在 host 包源码和测试、client 包源码和测试、脚本、示例以及网站代码中注入 `typescript/no-floating-promises` 违规，随后要求 Oxlint 单次调用报告全部七条诊断。它还让一个刻意格式错误的暂存文件依次通过 ESLint 格式化器和 Oxlint 验证器，并断言单次流程后的最终字节。门禁调度器测试锁定两项工作线程控制，仓库 lint 命令运行两个 JavaScript 兼容插件，类型检查则确认迁移引发的源码改动没有破坏 TypeScript 程序。

## 考虑过的替代方案

**在全仓库范围内同时运行两个 linter。** 所有正确性规则均可通过 Oxlint 原生规则、nursery 规则或 JavaScript 插件兼容层获得。在全仓库范围启用 ESLint 回退会保留较慢的项目服务初始化和两套正确性配置，却不会增加任何检查；保留的 ESLint 流程被刻意限制为不加载项目的暂存文件格式化。

**依赖兼容层修复。** 兼容层会报告既有的 `@stylistic` 规则，但在 Oxlint 的两种修复模式下都不会应用这些规则的修复。保留窄范围的暂存文件格式化器，可以在不将 ESLint 扩张回仓库 linter 的情况下维持贡献者契约。

**移除尚无原生实现的 @stylistic 或 SonarJS 规则。** 这会移除依赖，但也会削弱机械质量契约。兼容层会保留这些规则，直到能够通过单独决策评估原生替代规则。

**迁移期间用 Oxfmt 替换 @stylistic。** 格式化器迁移会产生超出 lint 引擎边界的输出变化，并带来全仓库格式 diff。保留既有规则可使本次变更便于评审，并让格式化器选择保持独立。

## 结果

本地迁移测量显示，不使用结果缓存时，一次无问题的类型感知 lint 运行从约 61 秒缩短至约 8 秒。确切比例因主机而异，不构成性能保证。

类型感知诊断现在来自通过 `oxlint-tsgolint` 捆绑的 TypeScript Go 分析器，因此即使 `tsc` 接受同一程序，边界场景下的类型推断也可能与 typescript-eslint 不同。lint 与类型检查仍是两项相互独立的必要证据。

JavaScript 插件兼容 API 和暂存文件格式化器是需要维护的额外边界。每次提交在 Oxlint 之前需要启动一次不加载项目的 ESLint，根目录开发依赖图仍保留 ESLint 和 TypeScript 解析器。全仓库验证、类型感知分析、缓存政策、工作线程控制和内联指令仍由 Oxlint 负责。
