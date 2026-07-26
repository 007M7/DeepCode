# dsh-fs-sandbox：强制沙箱的文件系统后端

[English](README.md) | 中文

`SandboxedFileSystem` 扩展 [`LocalFileSystem`](../fs-local/README.md) 并注册为 `ctx.fs`。它逐字继承全部文本存储机制（解析、stat、读取／流式读取、列出、原子写入、按读取、匹配、写入顺序执行的编辑临界区），只为 `writeText`/`editText` 增加按调用的模式围栏。读取始终直接通过：所有模式都允许读取。

只需加载它来替代 `dsh-fs-local`，并同时加载 [`ctx.sandboxPolicy`](../../sandbox/sandbox-policy/README.md)，即可完成替换；面向模型的工具（`dsh-tool-fs`）无需改动。工具层把调用会话的模式和 cwd 解析为与 bash 相同的按调用政策，因此两个能力族绝不会约束到不同根目录。

## 围栏

按调用政策携带有效模式（会话覆盖值或升级授权）和调用会话不可变的 cwd 根目录；只有没有会话的调用才回退到部署政策：

- `read-only`：以结构化 `FS_SANDBOX_DENIED` 拒绝所有变更；
- `workspace-write`：只有目标规范化后位于可写根目录下，才允许变更。可写根包括工作区根目录和平台临时区域（`/tmp`、`os.tmpdir()`），与 Seatbelt profile 授权的集合相同；该集合由唯一的 [`writableRoots`](../../sandbox/README.md) 函数派生，使 fs 围栏与 bash runner 不会漂移。规范拼写使用词法快速路径；基于身份的祖先回退可以识别 Windows 长名称和 8.3 名称等别名等价根目录，而不会把无关前缀视为包含关系。委托前会立即重新规范化目标，因此工具解析后被替换的祖先符号链接也会被发现；
- `danger-full-access`：不加围栏直接委托。

## 威胁模型：政策围栏，而非内核边界

围栏是在可信代码中检查模型控制的路径。操作本身属于 seam（open、rename），只有目标路径不可信，因此「规范化后检查包含关系」就是该接口的完整答案。这与 `code-runtime` 的立场相同：提供约束，但不是安全边界。不可信代码的内核级隔离仍由 `ctx.bash` 负责（[`dsh-bash-sandbox`](../../bash/bash-sandbox/README.md)）。剩余 TOCTOU（在包含关系复查与系统调用之间替换祖先符号链接）会通过写入前立即重新规范化来缩小，并为该威胁模型所接受；内核严密边界需要 `openat2` 一类原语，其可移植性成本在此不值得。

拒绝是结构化 `FsError`（`FS_SANDBOX_DENIED`，携带有效模式），不通过 stderr 文本推断（不同于 bash 的内核拒绝），因为进程内围栏准确知道自己拒绝了什么。面向模型的 `[sandbox: file access denied under <mode> mode]` 标记以及唯一一次获批的更宽权限重试位于工具层（`dsh-tool-fs`），与 bash 完全相同。见[跨能力族 fs 沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md)。

## 模型体验

通过 `dsh-tool-fs` 间接产生影响；该消费方把本后端的 `FS_SANDBOX_DENIED` 拒绝渲染为 `[sandbox: file access denied under <mode> mode]` 标记和同轮次升级提示。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与延期工作

- **政策围栏，而非内核边界**：该检查是可信代码处理模型控制的路径，因此解析到系统调用之间残留的 TOCTOU 会被原位重新规范化缩小，但不会消除；对抗性宿主进程不在范围内。不可信代码的内核级隔离仍属于 `ctx.bash`。
- **围栏与 runner 的一致性来自派生，而非断言**：可写集合来自 `writableRoots`，该函数与 Seatbelt profile 共享，并由一致性测试固定；不通过该函数更改可写集合的 runner profile 会发生漂移。
- **要求 `ctx.sandboxPolicy`**：工具使用它解析每个会话政策，后端用它处理无 agent 调用的回退；未组合该服务时，后端不会实施约束。
