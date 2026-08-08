# @deepseek-ai/dsh-client-ui-skill

[English](README.md) | 中文

skill（技能）调用 source 的浏览器端：把 `/` 触发的 `skill` source 注册进 `ctx.slash`。普通会话的候选来自 `skill.list` RPC，以每次调用的 `ClientSessionContext` 投影中的 `{sessionId}` 寻址，host 从会话 header 解析 `cwd`。宿主提供每一个用户可调用的 skill；`modelInvocable: false` 的条目（即 `disable-model-invocation` skill，此路径是其唯一入口）会以当前语言把仅限用户标记作为描述前缀带上。由目录寻址的可继续 subagent 在客户端解析为没有 skill 候选，因为现有 skill RPC 要求会话已挂载；查看其持久化历史不得激活它。目录按普通会话缓存，拉取走 single-flight；scope 创建时的 `warm` 钩子预热该会话的缓存项，`connection/reset` 清空全部缓存。结果按 `startsWith(query)` 过滤。

菜单 pick 或回车提交的一行 `/name [args]` 会把 composer 认领进一个容忍参数的 `skill.invoke` 事务（`matchEnter` 强等目录；未知名称应答 undefined，保持为普通提示词）。与宿主命令同名的 skill 名解析为命令：裁决按注册顺序轮询各 source，而 web bundle 把 ui-command 挂载在本 source 之前——这是有意的优先级，与同行产品一致。提交时会修剪参数、让空白参数不上协议，并把 RPC 拒绝折叠进 composer 的错误结局；宿主在开启轮次之前渲染 skill 正文并将其作为用户消息注入，因此对每一个用户可调用的 skill，调用都是确定性的。RPC 使用插件注册时捕获的根上下文连接——source 绝不从每次调用的参数上读取服务。草稿 chip 视觉仍由 `lexicon` 扫描派生；旧的 `<skill>name</skill>` 引用 codec 已经移除（决策 21 的移除裁定），`matchSpace` 保持不实现——skill 流程归菜单与回车所有。

`skill.list` 失败时 `candidates` 抛出异常，slash 壳层记录日志并折叠为静默的菜单组丢弃——菜单只显示 pending／ready 状态。

`/client` 导出表层只有插件主体（`apply`／`inject`）；source 对象是注册 effect 的内部实现。

## skill 工具行

浏览器插件还会把一个 key 为 `skill` 的 toolview 注册进 `conversation.chat.toolview`。收起的行以与 Bash 行相同的中性色层级显示 14 像素的 skill 文档与闪光组合图标、`Skill` 标题、分隔符和请求加载的 skill 名称；运行中的调用带有 transcript（文本记录）的扫光效果，失败时用错误首行替换名称，中断调用则使用警告状态。已结算的行以整行作为展开入口，展开后显示一个尺寸受限的 `Instructions` 卡片，其中原样呈现持久化的工具输出；可用时还会提供标准执行轨迹的 `Inspect` 入口。该行的名称、生命周期和正文只派生自当前 runtime 窗口中已配对的调用／结果片段，绝不读取当前 skill 目录，因此即使已安装的 skill 或其描述发生变化，回放仍保持稳定。

## 模型体验

### 用户显式 skill 调用

#### 模型看到的内容

被认领的调用绝不会把字面文本 `/name` 发出去。宿主（`skill.invoke`）渲染规范的 `<skill_content>` 块——与 `skill` 工具返回的 `renderSkillContent` 输出相同——在一个空行之后追加用户的尾随文本，并把整体作为一条携带 `skill-invocation` 来源的 user 角色消息注入，随即开启一个轮次。加载是确定性的：模型无需被要求调用 `skill` 工具就能收到完整正文，目录（由 `dsh-tool-skill` 渲染）也会告诉它不要重新加载已内联注入的 skill。

#### Token 影响

一次调用会把渲染后的 skill 正文连同尾随文本加进该轮次的用户消息——成本与模型经由工具加载该 skill 相同，只是无条件支付，而非由模型自行裁量。浏览菜单和拉取候选不会增加任何模型 token。

#### KV Cache 影响

仅追加：注入的消息落在可复用历史前缀之后。该包绝不改写较早的请求 token。

## 已知限制与暂缓事项

- **仅含结果的 history 页使用通用行**：键控分派要求配对调用位于 runtime 窗口内；分页将调用留在窗口外时，结果没有工具身份。这项客户端呈现功能不会为了恢复该身份而扩展 history 协议契约。
- **回车对目录只等待一次**：`matchEnter` 在应答之前强等该会话的首次目录拉取，因此与冷缓存竞速的回车会对照已落定的目录解析，而不是静默错过。预热落定之前打开的菜单，在那次击键下仍不会显示 skill 候选。
- **文本是唯一依据**：引用是普通的草稿文本；手动键入的相同 token 就是同一个引用。chip 视觉由 lexicon 扫描派生；没有 occurrence 身份或位置跟踪（组件化 chip 是台账事项）。
