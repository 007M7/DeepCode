# RFC：共享应用 bin 的启动胶水代码，不再维护两份副本

Status: implemented

[English](2026-07-04-share-app-bin-boot-glue.md) | 中文

## 问题

stdio 和 ACP bin 各自重复了环境加载、fail-loud 处理、入口校验与启动逻辑，包括微妙的 Loader 失败行为。两份副本已经发生漂移，且位于自执行文件中、被排除在单元测试覆盖率之外，导致其中的辅助导出无法被复用。

## 决策

辅助逻辑只存在一处：[`@deepseek-ai/dsh-app-boot`](../../../../packages/ui/app-boot)（`packages/ui/app-boot`，归入 `ui` 组，因为 bin 是已发布产物，其运行时依赖本身也必须是已发布的，而非 `support/`）。包含：`resolveConfigPath`（快照感知，两个 bin 共用的唯一路径解析器）、`loadEnv`、`installFailLoud`、`assertEntriesLoaded` 和 `boot`，每个函数都按 bin 的诊断前缀参数化，并在其副作用 seam（warn sink、process 切片）处可注入，使单元测试套件能覆盖每个分支——包括 `boot()` 在进程内驱动真实 Loader、使用相对路径 specifier 的配置，涵盖已就绪树的正常路径和无 fiber 入口的拒绝路径。该包（package）启用了逐文件 100% 覆盖率门禁；Loader 失败的经验知识只有一个归属地。

每个 `bin.ts` 是一个精简的自执行组合：在共享辅助逻辑之上叠加各自应用特有的生命周期（ACP bin：replay 模式下跳过环境加载与 stdin-EOF dispose；stdio bin：无额外逻辑）。bin 文件仍然被排除在覆盖率之外且不导出任何内容；已发布产物的防护措施不变——built-bin 冒烟测试仍然在一个 node_modules 形状的临时目录下用原生 node 运行每个 bin（现在也 symlink 了 `ui/app-boot`），并仍然断言缺少配置时的非零退出码，遵循「真实入口路径意味着已发布产物」的防御模式。[extract-example-app-packages RFC](../architecture/2026-06-20-extract-example-app-packages.md) 中关于 bin 归属的事实已相应修订。

## 曾考虑的替代方案

### 为什么不保留重复？

bin 被定位为独立拥有的已发布产物，而新增一个包有固定开销（manifest、README、tsconfig reference、publint 表面积），与去重的代码行数相当。但创建 bin 的那份 RFC 从未权衡过应用间共享——它把三个示例 `start.ts` 副本合并**进**了 bin 就止步了；漂移是已观察到的事实；而覆盖率缺口的论点独立于去重论点：这是仓库中唯一被豁免于逐文件 100% 门禁的非平凡运行时逻辑。记录在案的回退方案（仅将纯逻辑提取为各应用模块）可以结束豁免，但会保留两个经验知识归属地。

## 后果

- 启动胶水代码的变更（新增守卫、修复解析）只需落地一次，两个已发布 bin 自动继承；bin 之间不会再次漂移。
- `dsh-app-boot` 保持依赖精简（cordis + loader/include 对）——它是启动机制，不是应用接口。
- bin 自身的文件是近乎平凡的组合；所有带分支的逻辑都在覆盖率门禁之下。
