# Agent Note：web GUI 宿主的能力可辨识目录选择 seam

状态：已实现

[English](2026-07-28-directory-picker-capability-seam.md) | 中文

## 问题

web GUI 的"打开本地文件夹"流程被焊死在一种交互上：`host.pickDirectory` 调用编译进 `dsh-host-apiproxy` 的原生 OS 选择器（私有模块，仅测试注入缝）。这个形态服务不了远程部署——没有任何 OS 对话框能弹到另一台机器的浏览器里——而计划中的应用内目录浏览器（Figma `Harness` 802-56979）需要列举／创建原语，那是**另一种交互契约**，不是同一契约的另一种实现。想换交互只能改网关源码，违背仓库"一切皆插件"的立场。

## 决策

在 `packages/host/` 落一个三包能力 seam——`directory-picker`（接口）、`directory-picker-dialog`、`directory-picker-browse`（后端）——唯一契约方法 `capability()` 返回**可辨识联合**：`{ kind: 'dialog', pick(signal) }` 或 `{ kind: 'browse', list(path?), createDirectory(path, name) }`。网关（`dsh-host-apiproxy`）注入 `directoryPicker`，经 `host.describe.directoryPicker` 广播 kind，提供对应的 RPC，另一种 kind 的调用以 `directory-picker-unavailable` 应答；客户端按广播的 kind 分支，未知 kind 隐藏入口（可合并扩展的默认分支）。组合（`cordis.yml`）就是换装点；联合之所以可辨识，是因为后端差异在**交互形态**——压平成统一方法集会逼每个后端伪装另一方的形态。

并入本决策的位置与策略裁决：

- **不用 `ctx.fs` seam。** `packages/fs/` 是面向模型／会话的存储栈（policy 事件、sandbox 可换后端）。骑上去会把 GUI 浏览耦合进模型的限制后端——为模型换 `fs-sandbox` 绝不能改变 GUI 行为——而 OS 事实（home 锚定、隐藏约定）也不是存储原语。picker seam 保持无展示、无模型；`packages/host/` 是它消费方域的家。
- **依赖调研（手写 vs 引入）。** Node 标准库本身就是维护中的跨平台 OS 层（`readdir(withFileTypes)`、`homedir`、路径语义）；调研过的替代品都过不了依赖门槛——文件管理器包（`node-file-manager`、`files-and-folders`、Syncfusion 的 provider）是整套 HTTP 应用（契合度不过），盘符工具（原生插件 `drivelist`、约七年未更的 `windows-drive-letters`）健康度／比例失当。browse 后端是标准库上的薄适配。
- **隐藏条目：返回并打标。** 宿主标注 `hidden`（POSIX 点前缀约定）并返回全部条目；客户端过滤。展示策略留在客户端，计划中的"显示隐藏"开关变成纯客户端改动。Windows 的 `FILE_ATTRIBUTE_HIDDEN` 不被 dirent 暴露——记为限制，直到原生探测值回其成本。
- **符号链接：为可进入性而跟随。** 用 `stat` 探测符号链接（断链／循环→跳过）；面包屑保留操作者导航的逻辑路径，`workspace.create` 在接纳时本就做 realpath 规范化。
- **全盘可浏览，不做 roots 配置。** `workspace.create` 接受任意路径且 API 本就提供驱动 bash 的方法，浏览根只会是 UX 范围而非边界；没有消费方的可配置性过不了证据门槛。等到有部署需要再做。
- **dialog 后端保留。** 插件化正是目的：多方都能提供该 seam（Electron 壳可以原生提供 `dialog`）。后端命名从机制（`native`／`local`——两者都在本机运行）改为交互（`-dialog`／`-browse`）。

## 曾考虑的替代方案

- **给 `ctx.fs` 增加浏览方法。** 否决：上述权限域耦合；且面向展示的列举契约（hidden 标志、面包屑、home 锚点）不属于存储 seam。
- **统一方法集的 seam（`pick(): path`）。** 否决：应用内浏览器无法藏在一次宿主侧调用后面——浏览循环在客户端，需要协议上的原语；而对话框实现不了原语。交互差异不可约，故用判别标签。
- **apiproxy 里直接调标准库（不建 seam）。** 否决：换装点仍是改网关源码，失去 fixture／测试后端，与促成这项工作的插件教义相悖。
- **引入文件管理器／盘符枚举依赖。** 按上文调研否决；依赖政策要求记录于此。

## 后果

- `cordis.yml` 决定交互形态；`apps/cli` 当前挂 `-dialog`（行为不变），应用内浏览器 PR 将把默认翻到 `-browse` 并让 GUI 按 `describe` 分支。
- 协议新增 `host.listDirectory`／`host.createDirectory`、四个错误码与 `describe.directoryPicker` 字段；connection fixture 提供确定性浏览树供无密钥组装测试使用。
- 未来的新交互（或 Electron 的 `dialog` 提供方）只是一个后端包加一个客户端分支——无需网关手术。
- `ApiProxyDefaults.pickDirectory`（仅测试注入）删除；测试像提供其他服务一样提供 stub `ctx.directoryPicker`。
