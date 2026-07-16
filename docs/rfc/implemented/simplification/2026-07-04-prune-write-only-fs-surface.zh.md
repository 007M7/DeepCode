# RFC：从 fs seam 中移除只写字段与一个无效路由旋钮

Status: implemented

[English](2026-07-04-prune-write-only-fs-surface.md) | 中文

## 问题

[fs seam 拆分](2026-06-26-fsspec-style-fs-seam.md)将读取路由与策略从后端移入 `dsh-tool-fs` 和 `dsh-fs-policy`。四处接口保留了拆分前的形态——每次调用都填充，却无人读取：

1. **`dsh-fs-local` 中的 `STREAM_MIN_SIZE` + `FsIoInternals.streamMinSize`**——*在本次变更之前已被"无硬编码可调参数"审计移除，该审计将路由阈值改为 `dsh-tool-fs` 的 `readStreamMinSize` 配置；此处记录是为了完整呈现整个裁剪。*原始位置（`packages/fs/fs-local/src/fsio.ts`，从 `packages/fs/fs-local/src/index.ts` 再导出）：包括 fs-local 自身源码和测试在内，全仓库零读取者。后端不做读取路由——`readWholeText`/`streamWholeText` 是调用方自行选择的独立原语——真正的路由常量在消费方（`packages/fs/tool-fs/src/read.ts`，与 `info.size` 比较）。10 MiB 这个事实有两份镜像；后端那份是死代码，而该旋钮的 JSDoc 声称提供一个并不存在的"读取路由"覆盖。
2. **`FsTarget.inputPath`**（`packages/fs/fs/src/types.ts`）：每个后端和每个测试 fake 都必须编造一个"仅用于诊断"的值，而生产环境零读取者——策略插件和所有错误消息使用的是 `targetKey`/`displayPath`。`listDir` 的生产者暴露了语义摇摆：目录子项拿到的是裸条目名，这不是任何人的"输入路径"。
3. **`FsEditOutcome.replacements` + `.replaceAll`**（`packages/fs/fs/src/types.ts`）：`replacements` 生产环境零读取者（单匹配策略本身保留——它由后端内部的 `FS_AMBIGUOUS_EDIT`/`FS_EDIT_NOT_FOUND` 抛出强制执行，错误消息保留了内部计数）；`replaceAll` 仅被 `packages/fs/tool-fs/src/edit.ts` 中的 `formatEditOutput` 读取——作为工具已持有的 `replace_all` 参数的回声。精简后，`FsEditOutcome` 变为 `{ version, before, after }`，与 `FsWriteOutcome` 中真正由后端发现的字段对齐。
4. **`FileReadOutcome.limit` + `.version`**（`packages/fs/tool-fs/src/read-render.ts`）：由读取工具填充，但 `formatReadOutput` 只渲染 `offset`/`lines`/`totalLines`/`truncatedByBytes`，而 `fs/observed` 事件直接使用 `info.version`，不使用 outcome 的副本。

## 决策

删除 fs-local 常量及其再导出和 `streamMinSize` 旋钮（`FsIoInternals` 中剩余的旋钮确实被原子写入测试使用）；从 `FsTarget` 中移除 `inputPath`；将 `FsEditOutcome` 精简为 `{ version, before, after }`，并将 `replaceAll` 从解析后的参数传给 `formatEditOutput`；从 `FileReadOutcome` 中移除 `limit`/`version`。[filesystem.md](../../../core-data-structures/filesystem.md) 中的粘贴内容、`packages/fs/fs/README.md`，以及那些不得不编造被移除字段的测试 fake 随类型一起精简。

## 曾考虑的替代方案

### 为什么不保留？

未来的权限/隔离层可能需要解析前的路径来生成错误文本——但它需要的是*请求*，每个调用点仍然持有请求。"替换了 N 处"可能成为面向模型的文本——那是需要时再设计的行为变更，且后端内部的计数为其错误消息保留着。读取页脚可能展示 `limit`——页脚展示的一切已经可以从 `lines`/`totalLines` 推导。与此同时，当前和未来的每个后端（远程、原生）都必须编造无人消费的协议格式（wire format）字段，每个测试 fake 都必须满足它们。

## 验证

被移除的接口已不存在——`dsh-fs-local` 中的 `STREAM_MIN_SIZE`/`streamMinSize`、`FsTarget.inputPath`、`FsEditOutcome.replacements`/`.replaceAll`、`FileReadOutcome.limit`/`.version`——而请求侧的 `replaceAll`（`FsEditRequest`）和其他 outcome 类型上的 version 字段未受影响；测试 fake 随类型一起精简。`formatEditOutput` 在 `replace_all` 两个分支下的输出文本不变，因此没有快照 golden 被搅动。

## 后果

后端不增加新义务；它们卸下了四个无人消费的字段。fs 发现工作（glob/grep 工具）触及相同的 `dsh-fs` 类型文件——这是文本层面而非设计层面的重叠，可以机械地解决。
