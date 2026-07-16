# RFC：生成 RFC 索引表

Status: implemented

[English](2026-07-04-generate-rfc-index-tables.md) | 中文

## 问题

RFC 索引中按生命周期/按类别的表格所列信息完全可推导：RFC 的路径编码了生命周期与类别，文件名编码了首次提出日期，H1 标题即为标题。手工维护这些事实的副本恰恰是本仓库文档中冲突最频繁的热点：每一波提案都向同几行追加行，因此并行的 RFC 分支恰好在此处冲突，而在其他所有地方都没有分歧；每次冲突都要手动合并那些文件系统本已知晓内容的行。[分类 RFC](2026-06-20-rfc-classification.md) 最初为了策展目的保留手写索引，但 README 中真正需要策展的部分是行文，而行文从不冲突；冲突的只有机械表格。

## 决策

保留策展行文；生成列表。表格位于 [`docs/rfc/INDEX.md`](../../INDEX.md)，是一个**完全生成的文件**；策展行文留在 README.md 中，README.md 不包含任何索引行。[`scripts/rfc-index.ts`](../../../../scripts/rfc-index.ts) 是共享的真源：树遍历器（拥有封闭的生命周期/类别集合与结构规则，包括 H1 可解析的要求）和渲染器（行来自 H1 标题并去除 `RFC: ` 前缀，加上文件名日期，按日期再按文件名排序，以 `### {Class}` 分节、按规范类别顺序分组）。两个轻量消费方共享它：

- [`scripts/gen-rfc-index.ts`](../../../../scripts/gen-rfc-index.ts)（`pnpm run gen-rfc-index`）从目录树完整重写 INDEX.md。
- [`scripts/verify-rfc-classification.ts`](../../../../scripts/verify-rfc-classification.ts)（doc-sync 的一个成员）检查结构，断言已提交的 INDEX.md 与新鲜渲染结果逐字节一致（与 `gen-cordis-catalog`/`verify-cordis-catalog` 模式相同），并拒绝在策展 README 中出现索引格式的行。新鲜度检查涵盖了索引完整性检查：从磁盘生成的表格在定义上就是完整且标题正确的。

添加、移动或删除一个 RFC 只需编辑 RFC 文件本身并运行生成器；分类 RFC 的「否决替代方案」记录中带有取代关系的交叉链接。

## 曾考虑的替代方案

### 为什么不在 README.md 内使用标记分隔区域？

最初落地的形态：生成器在 README.md 中的 `gen-rfc-index` 标记注释之间、每个 `## {Lifecycle}` 标题下拼接表格。在 README 同时吸收了文件内格式契约（[统一格式 RFC](2026-07-05-uniform-rfc-format.md)）之后，被整文件 INDEX.md 方案取代：一个门面 README 承载数百行生成行，会淹没其策展行文；而拼接机制（标记对、标题检查、区域外行检测）的存在只是为了保护策展文本——专用的生成文件根本不包含策展文本。

### 为什么不采用纯校验模式？

纯校验能捕获错误，但每次提案编辑仍然要在手工维护的表格中触碰共享热点；对于一行纯机械内容，校验失败比生成器更令人烦恼：作者已经命名并放置了文件，索引副本不增加任何信息。这与 [package-inventory 提案](../../proposed/process/2026-06-20-discover-package-inventory.md) 对 tsconfig references 和 knip stanzas 所做的「手工列表 vs. 推导」判断相同——应用于这张确实会冲突的列表。

## 后果

- 生成文件是显式的：其横幅标注了生成器名称，文件内没有需要保护的策展区域，且生成器在目录树结构无效时拒绝运行。
- 格式错误或缺失的 H1 在生成器和门禁中都是硬错误：H1 现在是承重的，它是索引标题的来源。
- 并行的 RFC 分支通过重新运行生成器来解决索引冲突，而非手动合并行。
