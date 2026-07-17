# DeepSeek Harness SDK 后续工作设计

> 状态：设计成稿，供通读与评审。定案后由 ccyu 转正式 RFC 并双语化。本文件为临时设计文档，不走 doc-sync / 文档预算门禁。
> 一句话：**SDK 初版已合并；本轮把"创建项目""创建插件""遥测""交互测试"四块补齐，核心是抽出一个既撑交互又撑 headless 的创建内核，其余三块围绕它扩展。**

## 0. 总览（一屏读完）

抽一个既撑交互又撑 headless 的**创建内核**（`Prompter` seam + 复用已有 `ProjectEditSession` + `CreationDriver` 发 NDJSON），四块活围绕它扩展。

| 块 | 做什么 | 核心对象 | 结论要点 |
|---|---|---|---|
| **#1 headless + skill** | create/config 非交互化，agent 端到端建项目 | `HeadlessPrompter` + `CreationDriver`(NDJSON) | 无 spec 文件、传结构化对象；薄 SKILL.md 入口；beyond-eve |
| **#2 建插件** | `dsh-sdk create <github\|npm>` 加依赖并挂载 | PM 原生 `add` + `ProjectEditSession` cordis 挂载 | npm/pnpm 原生依赖（`github:#sha` / `pkg@version`），不用 giget/pacote |
| **#3 遥测** | 每个 `dsh-sdk` 命令上报 | `TelemetryReporter` / `ConsentResolver` / `SecretRedactor` | 发 cordis.yml+package.json 全文；不发 `.env`、疑似密钥脱敏；关闭 = cordis.yml 有明确 disabled 的遥测条目（甲）|
| **#4 交互测试** | 覆盖 wizard 各分支、快照 cordis.yml | `WizardHarness` + clack mock 注入 | 注入流为主、真 PTY 仅 1–2 个可选 smoke |

**节奏**：先做地基（`Prompter` 重构，同时解锁 #1+#4，不并行）→ 再 fan out 四棵 teammate worktree。

细节见下文；不想通读的话，读完本节 + §5（砍掉的路线）+ §6（节奏）即可。

## 1. 背景与现状

SDK 初版（`packages/sdk/*`）已经落地三个包：

| 包 | 职责 | 当前局限 |
|---|---|---|
| `@deepseek-ai/create-sdk` | `npm create @deepseek-ai/sdk` 交互式建项目 | **TTY-only**：flag 只能预填问题，创建仍须交互终端；feature 配置面窄，复杂 feature 难在命令行表达 |
| `@deepseek-ai/dsh-helper` | 项目领域模型：feature 催表、蓝图、`ProjectEditSession`（唯一的改写/提交边界） | create-sdk 与 `dsh-sdk config` 共用同一套催表与 configurator，但目前只被交互式 wizard 驱动 |
| `@deepseek-ai/dsh-scripts` | `dsh-sdk` launcher：`start` / `dev` / `build` / `config` | `config` 同样 **TTY-only**；`build` 只跑 tsdown、`create` 时项目尚不存在——两者都不 boot cordis |

四块后续工作：

1. **非交互（headless）创建 + 通过 skill 创建**（#1）：去掉 create/config 的 TTY-only 限制，让 agent 能端到端把项目建出来。
2. **`dsh-sdk create <source>` 从 github/npm 建插件**（#2）：把外部插件拉进现有项目并接线。
3. **遥测**（#3）：每次 `dsh-sdk <command>`（含 create/首次初始化）上报开发者周期数据。
4. **终端交互测试**（#4）：给 clack wizard 加可回归、可核对的交互测试。

## 2. 边界澄清：三件事分开

调研 `vercel/eve` 及其引用的 `skills` CLI 后，确认三件事必须分开、不能混：

| 轨 | 命令入口 | 产物 |
|---|---|---|
| **建项目** | `npm create @deepseek-ai/sdk`（现有 wizard）+ 其 headless 形态（本轮新增） | 一个新的 SDK 项目 |
| **建插件** | `dsh-sdk create <github\|npm>`（现有 create-plugin 扩展） | 现有项目里多一个接好线的插件 |
| **分发 skill** | 发 SKILL.md → agent `npx skills add deepseek-ai/<repo>` | 任意 agent 拉到我们的 skill playbook |

事实依据：`skills`（vercel-labs/skills）是 markdown SKILL.md 的包管理器，来源只认 github/git/本地、不认 npm scope，只往 agent 的 skills 目录丢文件，不建项目、不 install；eve 建项目走的是独立的 `npx eve init`。因此 `npx skills add @deepseek-ai/sdk`（把"装 SDK"和 `skills add` 揉在一起）不是真实用法，本设计据此拆开。

## 3. 总体架构

### 3.1 核心洞见：一个创建内核，四条轨围绕它

四块活看似独立，实则都咬合在同一组对象上。**建项目和改配置的本质是"问答 → 改项目文件"**，而 `dsh-helper` 已经有唯一的改写边界 `ProjectEditSession`。本轮把"问答"这一侧也抽成 seam，就能让交互与 headless 共用一套逻辑，测试和 skill 顺势接上去。

```
                      ┌───────────────────────────────┐
                      │  CreationDriver / SetupRunner  │  编排：问答序列 → 组装 spec → 驱动改写
                      │        (emits NDJSON)          │
                      └───────────────┬───────────────┘
             借助                     │ 驱动
   ┌─────────────────────┐           │           ┌────────────────────────────┐
   │   Prompter (seam)    │◄──────────┘           │  ProjectEditSession (已有)  │  唯一改写/提交边界
   ├─────────────────────┤                        └────────────────────────────┘
   │ InteractivePrompter │  clack + 注入 input/output（解锁 #4 测试）
   │ HeadlessPrompter    │  永不阻塞：答案取自结构化 spec，缺必答项→抛错/发 action-required（解锁 #1 + skill）
   └─────────────────────┘
```

- **`Prompter`（新 seam）**：把"向用户要一个答案"抽象出来。两个实现：
  - `InteractivePrompter`：clack 实现，接受注入的 `input`/`output` 流（不再硬绑 `process.stdin/stdout`）。这正是 #4 交互测试的前置。
  - `HeadlessPrompter`：永不阻塞——答案取自调用方传入的结构化 spec；遇到未提供的必答项，直接**响亮失败**（抛错 / 发 `action-required` 事件），不猜默认。这是 #1 headless 与 skill 驱动的地基。
- **`ProjectEditSession`（复用已有）**：唯一的改写/提交边界。create、config、以及 #2 建插件改 cordis.yml，全部经它落盘。
- **`CreationDriver`（新，或改造现有 wizard 编排）**：跑问答序列、组装项目 spec、驱动 `ProjectEditSession`；headless 模式下向外发 **NDJSON 生命周期事件**（`action-required` / `done` / `error` / 进度）。
- **skill 路径**：agent import 这个内核、传结构化 config 对象、读 NDJSON 事件；附一层薄 SKILL.md 教 agent 怎么驱动。

**扩展点**：新增一个 feature 只改 `dsh-helper` 的催表/催配置器；交互与 headless 两条路都自动获得它，不需各改一遍。

> **读码修正（重要，落地以此为准）**：上文 `Prompter`/`InteractivePrompter`/`CreationDriver` 是概念名，对应现有代码：
> - **seam 已存在**：`dsh-helper` 的 `PromptPort`（`questions/prompt-port.ts`）即 `Prompter`；问答走 `Question.resolve(port, prefilled?)`——给了 prefill 就不碰 port。
> - **交互实现 + 注入已存在**：`ClackPromptPort` 构造函数已接受注入 `input`/`output`（源码注释即 "for snapshots and tests"）；`CreateWizard` 与 `ConfigWorkflow` 都已接受注入的 `PromptPort` + `output`。
> - **⇒ #4 交互测试不被地基阻塞**：注入点今天就有，已单独开 teammate 并行做（覆盖 create + config 两个 wizard）。
> - **地基真正要做的（比原设想小）**：新增 `HeadlessPromptPort implements PromptPort`（缺项 fail-fast + 发 NDJSON）+ 补全 prefill 覆盖——目前 feature 选择走原始 `nestedMultiselect`、`FeatureConfigurator` 的 valueInputs 无 prefill、suggests 确认无 prefill；headless 要让结构化 spec 喂满这些点。

### 3.2 四块如何咬合到这组对象

| 块 | 落在哪个对象 | 关系 |
|---|---|---|
| #1 headless + skill | `HeadlessPromptPort`（实现已有 `PromptPort`）+ prefill 补全 + NDJSON | 地基（缩小版）|
| #4 交互测试 | 注入 `ClackPromptPort(mockIn, mockOut)` 进已有 `CreateWizard`/`ConfigWorkflow` + `WizardHarness` | **注入点已存在，不阻塞，已并行开工** |
| #2 建插件 | `PluginSource` + `PluginFetcher` + 经 `ProjectEditSession` 接线 | 复用改写边界 |
| #3 遥测 | launcher 侧 `TelemetryReporter` + `ConsentResolver` + `SecretRedactor` | 独立于内核，挂在 launcher 命令生命周期 |

## 4. 详细设计

### 4.1 headless 创建 + skill（#1）

**目标**：`create-sdk`（建新项目）与 `dsh-sdk config`（改现有项目）都能非交互运行；agent 能端到端把项目建完。

**设计**：

- **Prompter seam**：如 §3。交互走 `InteractivePrompter`，headless 走 `HeadlessPrompter`（fail-fast + NDJSON），二者背后是同一套 `dsh-helper` 催表和同一个 `ProjectEditSession`。
- **输入编码**（次要、可解耦）：
  - **agent 路径**：传结构化 config 对象（程序化，或 `--config-json '{...}'`）+ 读 NDJSON。**不需要 spec 文件**——与 eve 一致；我们 feature 比 eve 重（嵌套有限选项 + 密钥），结构化对象比一长串扁平 flag 干净。
  - **人 / CI 路径**（可选）：`--config <file>`（yaml/json）或 flags，只是喂给同一内核的另一种编码。
- **skill**：核心是 headless 内核；agent 传参直接建完，缺必答项就响亮失败让 agent 补答。附一层**薄 SKILL.md**（指向内核、教 agent 驱动），让"通过 skill 创建"字面落地。
- **比 eve 更进一步**：eve 把 headless 原语（`runHeadless` + 非阻塞 Prompter + NDJSON）造好了，却没接到它的 skill——它的 SKILL.md 只指向半交互 CLI，且 agent 跑 `eve init` 时只打印指引、打回给人。我们把 **skill → headless 内核接通**，才真正做到"headless 为 skill 服务"。

### 4.2 `dsh-sdk create <source>` 建插件（#2，简单版）

**目标**：把一个 github repo 或 npm 包当**依赖**加进现有项目并挂载；用包管理器原生能力，**不引 giget/pacote**。

**设计（PM 原生依赖 + cordis 挂载）**：

- **来源**：npm（`pkg@version`）或 github（`github:owner/repo#ref`，推荐锁 commit SHA）。npm/pnpm/yarn 原生支持这两种依赖来源，自己解析包名、把 commit/integrity 钉进 lockfile。
- **流程**：`dsh-sdk create <source>` → 确认（TTY guard 同 config）→ 用项目的包管理器 `add <source>`（PM 解析名字 / 装依赖 / 写 lockfile）→ 读回新增依赖名 → 经 `ProjectEditSession` 挂一条 cordis 条目引用它 → commit。
- **不落 `plugins/`**：外部插件是 node_modules 依赖，不是本地生成插件（后者才走 `LocalPluginBlueprint` + 文件生成）。
- **构建张力（暂缓）**：源码型 github 插件装时要 `prepare` build（pnpm 10.26 默认禁、需 `allowBuilds` 放行）——"预编译-only vs 允许构建"的取舍留到以后；先做能跑的简单版，交给 PM 默认行为。
- **弃用**：早期设计的 `PluginSource`/`GigetFetcher`/`PacoteFetcher`（抓 tarball 到 temp 再接线）已随 `dsh-plugin-fetch` 包一起撤掉——PM 原生依赖覆盖了它。

### 4.3 遥测（#3）

**目标**：每次 `dsh-sdk <command>`（create / dev / build / config / start / 首次初始化）上报当前 `cordis.yml` + `package.json` 内容。

**设计**：

- **上报器位置**：在**我们自己的代码执行时机**里——`create-sdk` 进程 + `dsh-scripts` launcher 进程，包住命令生命周期。
  - 理由：`build` 只跑 tsdown、`create` 时项目还不存在，都不 boot cordis；写在 cordis.yml 里的 cordis 插件抓不到它们。调研的全部工具（Next/Astro/Nuxt/Vite/Angular/Gatsby/Turbo/Homebrew）无一例外把上报器放 CLI/launcher，从不放 app 运行时。
- **`TelemetryReporter`（launcher 侧）**：包住命令，收集 `{command, 时长, 成败, cordis.yml 内容, package.json 内容}`。
- **`ConsentResolver`**：在每个命令**解析（非 boot）`cordis.yml`**，读遥测插件状态当 consent。**关闭（甲，ccyu 拍板）= cordis.yml 里有一条明确 `disabled` 的遥测条目**；其余一切（无 cordis.yml / 有文件但无遥测条目 / 有 enabled 条目）都上报——唯一的关只有"存在且 disabled"，无不对称。（可选、近零成本补充，留到实现定：额外认 `DO_NOT_TRACK` / CI 自动关。）
- **`SecretRedactor`（安全硬线）**：绝不发 `.env`；cordis.yml / package.json 里若出现类似密钥的值，**脱敏替换**（redact 占位，不整段丢）。依赖 SDK 约定——密钥只进 `.env`、cordis.yml 只引用 env 不内联——脱敏是兜底。
- **匿名 id**：全局配置里的随机 UUID；**绝不从 git remote / repo URL 派生**。
- **endpoint**：内置在代码里。
- **consent 承载**：遥测作为 `create` 时默认打开的 feature 写进 cordis.yml（对用户可见、随项目）。

> **接线现状（读码修正）**：launcher 上报已接通——`runDshSdkCommand` 计时包住每条命令，`finally` 里 resolve consent（甲）→ 建 redacted payload（cordis.yml+package.json 全文、不读 .env）→ fire-and-forget 上报 + flush，best-effort 永不影响命令结果。**默认开**：无遥测条目 → 甲 → 上报。**opt-out 现状**：在 cordis.yml 手动加一条 `disabled` 的 `@deepseek-ai/dsh-telemetry` 条目即关（`ConsentResolver` 读到 disabled → 不报；disabled 条目 cordis 不加载，故不会因"它不是运行时插件"而 boot 失败）。
> **暂缓（催表 opt-out 开关）**：把"关遥测"做成 config/create 向导里的勾选项还没做。关键约束：`@deepseek-ai/dsh-telemetry` 是 **launcher 库、不是 cordis 运行时插件**，所以 consent 条目只能以 **disabled 形态**存在（enabled=无条目=甲默认报；要关才写 disabled 条目），不能像普通 feature 那样挂一个 enabled 的可 boot 条目。向导化这个"只在关闭时才出现条目"的特殊语义留作后续。

**在案取舍**：发全文会把第三方（含私有 scoped）包名、cordis 配置值（base-url/路径）暴露给 endpoint 持有方；主流工具都不发这些（Turbo 排除包名、Angular 禁模块名）。ccyu 作为本 SDK 维护者接受此暴露——目的即掌握开发者用了哪些 plugin/依赖/配置。

### 4.4 交互测试（#4）

**目标**：CI 仅 mac/linux；覆盖 create wizard 主流程 + config wizard 各选择分支；产出不同选择下的 `cordis.yml` 快照便于核对。

**设计（clack mock 注入，不上真 PTY 打头阵）**：

- **主力**：进程内注入 mock stdin/stdout。`@clack/prompts` 官方支持 `input`/`output` 注入，`isTTY=false` 时自动跳过 raw mode——零原生依赖、mac/linux 天然确定。**前置已就绪**：`ClackPromptPort` 已接受注入流，`CreateWizard`/`ConfigWorkflow` 已接受注入 `PromptPort`。
- **`WizardHarness`（测试工具）**：用脚本化 keypress 序列（`input.emit('keypress', …)` 走 down/space/return）驱动 wizard、写到 temp 目录、返回生成的 `cordis.yml`。
- **断言**：`test.each(选择组合)` → `toMatchFileSnapshot('<combo>.cordis.yml')`；**快照生成的 cordis.yml**，不快照交互 transcript（transcript 脆、且是在测 clack 自己）。
- **可选 1–2 个真 PTY smoke**：仅覆盖"真二进制 + interactive-vs-CI TTY gate"这条注入测不到的分支；node-pty 在我们 Node（`^22.19 || >=24`）上有原生编译风险，**挪出关键路径**，缺工具链 self-skip。

## 5. 砍掉的路线（调研依据）

| 砍掉的路线 | 理由 |
|---|---|
| #4 用真 PTY（node-pty）打头阵 | clack 官方支持注入流，无需真 TTY；node-pty 在我们 Node 版本上有原生编译风险。真 PTY 降级为 1–2 个可选 smoke |
| #4 快照交互 transcript | transcript 受重绘/spinner/ANSI 影响脆弱，且主要在测 clack 渲染而非我们的生成逻辑 |
| #3 上报器做成 cordis 插件 | `build`/`create` 不 boot cordis，插件抓不到；无一主流工具用 app 内插件做遥测 |
| #3 匿名 id 从 git remote 派生 | 会让"匿名"变假（Next 因此挨批） |
| #1 headless 以 spec 文件为主 | eve 没有 spec 文件；agent 路径传结构化对象更干净，spec 文件退成人/CI 可选 |
| #2 从 npm/github 拉完自动 install+build | 会执行被拉代码的 postinstall，供应链风险；改为只解压 + 显式接线 + `--ignore-scripts` |
| #1 用 `npx skills add` 创建项目 | `skills` 是 markdown SKILL.md 包管理器、不建项目、不认 npm scope，属概念混淆 |

## 6. 推进节奏：地基缩小，已并发开工

**读码后修正**：`PromptPort` seam + 可注入的 `ClackPromptPort` + 可注入的 `CreateWizard`/`ConfigWorkflow` 都已存在，所以地基比原设想小，且 #4 不再被它阻塞。当前并发结构：

1. **地基（主线程，我做）**：新增 `HeadlessPromptPort implements PromptPort`（缺项 fail-fast + 发 NDJSON）+ 把 prefill 覆盖补全（feature 选择、valueInputs、suggests 确认），让结构化 spec 能喂满 create/config；顺带把 launcher 命令注册、helper 催表扩展点留成清晰 seam。这是 #1 headless 与 #2/#3 接线步的公共前置。
2. **已并行开工的 teammate worktree**（与地基低冲突，只碰各自新模块）：
   - **树 B 建插件**：`PluginSource` + `GigetFetcher`/`PacoteFetcher`（greenfield；`dsh-sdk create` 命令注册 + cordis.yml 接线等地基后再做）。
   - **树 A 遥测**：`SecretRedactor` / `ConsentResolver` / `TelemetryPayload` / `TelemetryReporter`（greenfield；launcher 接线 + 催表加 feature 等地基后再做）。
   - **树 C 交互测试**：`WizardHarness` + create/config 的 `test.each` cordis.yml 快照（注入点已就绪，可全量做）。
3. **地基落地后的收尾**（接线，碰共享文件）：#2 的 `dsh-sdk create` 命令注册 + cordis.yml 接线；#3 的 launcher 上报接线 + 催表遥测 feature；#1 的 skill 薄封装 + `--config-json`/`--config` 入口。
4. **合并**：stacked PR，地基在底，其余 rebase 到地基上，逐层向上同步。
   - **树 D 薄 SKILL.md**：SKILL.md + 相关文档（并入第 3 步收尾）。

> 冲突面：树 A/B 的接线步都会碰 `dsh-scripts` 命令注册与 `dsh-helper` 催表——地基里须把命令注册做成可加式（各命令自注册）、催表扩展点清晰，接线才能真正独立、rebase 顺滑。greenfield 模块阶段（当前）不碰这些共享文件，所以能安全并行。

## 7. 各轨改动清单

| 轨 | 主要包 | 关键改动 |
|---|---|---|
| 地基 | dsh-helper, create-sdk, dsh-scripts | `HeadlessPromptPort`（实现已有 `PromptPort`）+ prefill 补全 + NDJSON + 命令注册/催表扩展点整理 |
| #1 headless+skill | create-sdk, dsh-scripts, （新）skill 包 | 结构化 spec 入口 `--config-json`/`--config`、薄 SKILL.md |
| #2 建插件 | dsh-scripts, dsh-helper | `dsh-sdk create <source>` 命令、PM `add`、经 `ProjectEditSession` 挂 cordis 条目、无新依赖 |
| #3 遥测 | （新）telemetry 包, dsh-scripts, dsh-helper | `TelemetryReporter`/`ConsentResolver`/`SecretRedactor`、launcher 接线、催表遥测 feature、内置 endpoint、全局 UUID |
| #4 测试 | packages/support, （已可注入）create-sdk/dsh-scripts | `WizardHarness`、create/config 的 `test.each` cordis.yml 快照、可选 PTY smoke |

## 8. 调研来源

- eve / skills：https://github.com/vercel/eve · https://github.com/vercel-labs/skills
- 从源拉取：https://github.com/unjs/giget · https://github.com/npm/pacote · https://github.com/Rich-Harris/degit
- 遥测规范：https://nextjs.org/telemetry · https://astro.build/telemetry/ · https://github.com/nuxt/telemetry · https://angular.dev/cli/analytics · https://turborepo.dev/docs/telemetry · https://consoledonottrack.com
- PTY / clack 测试：https://github.com/bombshell-dev/clack · https://vitest.dev/guide/snapshot · https://github.com/microsoft/node-pty
