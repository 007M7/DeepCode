# Agent Note: glob/grep 改用打包的 ripgrep 二进制直接 spawn

Status: implemented

[English](2026-08-01-packaged-ripgrep-search.md) | 中文

> 取代 [bash 承载的 grep/glob 发现工具](../../archived/feature/2026-07-09-bash-backed-grep-glob-discovery.md)：v1 决策中明确延期的方案——直接 spawn ripgrep——现在成为实际交付的实现。

## 问题

`glob`/`grep` 工具经由 bash 执行器 seam 运行，这使系统 `rg` 安装成为宿主依赖。Windows 和容器镜像的 `PATH` 默认没有 `rg`，工具在那里会静默消失；部署方只能从加载期探针警告里发现这一点。bash seam 还迫使整个模型可见参数面经过一个 shell 引号工具，因为工具与 ripgrep 之间隔着一层 shell——[bash 承载决策](../../archived/feature/2026-07-09-bash-backed-grep-glob-discovery.md) 把这种耦合记为 v1 的取舍，并把直接 spawn 列为 shell 字符串域一旦被证明过于敏感时的合理后续。它确实被证明了：每个模型值都要经受 POSIX 单引号转义，探针要在测试里脚本化，执行器自身的超时分类还与协作式工具超时策略已有的职责重复。

## 决策

`@deepseek-ai/dsh-tool-fs-search` 现在运行 PACKAGED（打包的）ripgrep 二进制（`@vscode/ripgrep`，一个 npm 依赖，其可选平台包随附二进制），经由 `ctx.subprocess` seam：`runRipgrep()` 以纯 argv 向量 spawn `rgPath`，配以 collect 模式 stdout/stderr、`graceMs` 与转发的 `exec.signal`。不再有 shell 层，执行路径上的 shell 引号边界随之消失；`singleQuote` 作为兼容导出与其测试保留。注册变为无条件——加载期 `command -v rg` 探针与条件注册决策被删除，连同那条 "rg not found" 警告。本包注入 `tools`、`systemPrompt` 与 `subprocess`。

退出语义仍由工具拥有：退出码 0 为有结果的成功，1 为成功的空搜索，其余归入既有 `SEARCH_*` 词汇（无效模式、启动失败、信号杀死、原始输出溢出）。超时是挂在工具定义上的协作式工具调用预算：`@deepseek-ai/dsh-timeout-policy` 中止 `exec.signal`，subprocess seam 的终止升级提供硬终止，工具报告 `SEARCH_ABORTED`。工作目录为会话 header cwd（存在时），否则为 `process.cwd()`——不再有执行器配置可供默认化，因此回退由工具自己拥有。

`fs-glob-sampling` ACP 快照场景改为执行真实的打包二进制，作用于一个用固定 mtime 钉住 `--sort=modified` 顺序的预制工作区，取代 PATH 注入的 `rg` 替身（仅 POSIX：展示路径携带 `/` 分隔符，会话日志比较无法归一化）。

## 备选方案

**保留 bash seam 与探针，仅把 `rg` 记为必需宿主依赖。** 否决：宿主依赖正是本次改动要消除的失败模式，而让发现工具支持 Windows 正是此举的目的；写进文档的依赖仍是依赖。

**让 `rgPath` 可注入（配置字段或环境变量覆盖），让测试与快照继续替换替身二进制。** 否决：这会新增一个只有测试 seam 会消费的公开部署面，而真实二进制本身足够确定——通过 fixture mtime 即可直接钉住；打包二进制就是部署形态，测试应当拿它来测。

**改用纯 JS 的 glob/搜索引擎（如 `picomatch`/`tinyglobby`）。** 否决：[依赖替换审计](../../rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md) 已基于"不存在 glob 引擎"的证据否决过该方向；ripgrep 语义（`--sort=modified`、VCS 剪枝、JSON 传输、正则方言）就是工具契约。

## 后果

- 发现工具在打包二进制覆盖的每个平台（darwin/linux/win32，x64/arm64）上开箱即用，无需宿主安装；交付的 TUI/Web 工具清单把 `glob`/`grep` 变为固定成员（见 [拉平交付的工具清单](../feature/2026-07-31-even-out-shipped-tool-rosters.md)）。
- shell 字符串攻击面消失：恶意模式只是惰性 argv 元素，由集成套件钉住；该套件现在也在 Windows 上运行（此前没有系统 `rg` 时它自行跳过）。
- 加载期失败模式改变：subprocess seam 损坏现在让首次搜索调用失败（`SEARCH_FAILED`），而非通过探针使插件加载失败；二进制缺失是带打包路径的启动失败，而不是 PATH 问题。
- 集成套件的 fixture 去掉了 Windows 无法表示的文件名（名称含 `"`），保证套件在每个平台都能重放。
