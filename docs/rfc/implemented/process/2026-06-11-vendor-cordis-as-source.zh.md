# RFC：以源码形式收录 Cordis，而非 npm 依赖

Status: implemented

[English](2026-06-11-vendor-cordis-as-source.md) | 中文

## 问题

DeepSeek Harness SDK 基于 Cordis 框架构建。本仓库启动时，Cordis core 处于 4.0.0-rc.6（一个发布候选版本）；harness 依赖框架内部实现（fiber 生命周期、effect dispose（资源释放）、waterfall（瀑布式事件）分发），这些行为的精确语义直接关系到 agent loop（智能体循环）的正确性保证。

## 决策

将所需的 Cordis 包（core、loader、include、group、timer、hmr、logger-console）及 cordiverse 基础库（cosmokit、schemastery）以源码形式扁平复制到 `vendor/`，保留其原始 npm 包名，使 workspace 解析透明。真正的第三方依赖（js-yaml、chokidar、@standard-schema/spec 等）仍留在 npm。

`vendor/README.md` 是 manifest（元数据清单）：记录每个包的上游仓库 + commit SHA，以及一份详尽的本地修改日志。pre-commit 守卫（`scripts/check-vendor-manifest.sh`）会拒绝未在同一次提交中更新 manifest 的 vendor 源码改动。

## 曾考虑的替代方案

- **依赖 npm 包**：否决。core 处于发布候选阶段，且 harness 依赖框架内部实现（fiber 生命周期、effect dispose、waterfall 分发），agent loop 的正确性保证取决于这些行为的精确语义；上游 RC 版本升级可能在没有本地修复路径的情况下破坏它们。
- **传递性地收录所有依赖**：否决。真正的第三方依赖（js-yaml、chokidar、@standard-schema/spec 等）仍留在 npm；只有内部实现对我们有影响的框架层才被纳入自有管理。

## 后果

- harness 完全拥有其框架层：可审计、可打补丁、版本锁定。上游 RC 无法破坏我们，框架 bug 可以在仓库内直接修复。
- 上游同步是手动的（manifest 中记录了操作步骤）。修改日志使 diff 面始终可知。
- vendor 包保留上游代码风格；lint 与严格性门禁将其排除（它们的 tsconfig 在本地放宽了我们较新的编译器 flag）。
- 从第一天起就存在一个本地补丁：移除了 HMR 的 locale-YAML 导入（运行时 YAML 导入钩子未被收录）。
