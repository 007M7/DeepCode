# Agent Note: Session List Browsing and Manual Workspace Order

Status: implemented

[English](2026-07-25-session-list-browsing-and-manual-order.md) | 中文

## Problem

[Workspace UI 完整产品流](2026-07-25-workspace-ui-product-flow.md)交付了分组 session 列表的首个形态,并把 Rename、拖拽排序等操作明确划出当期范围。设计稿(figma 239-10458 及关联画面)随后补齐了这些交互:列表要能切换成不分组的平铺视图、session 行悬停要出详情卡与操作菜单、workspace 要能改名、组内 session 要能手动排序。

两条既有机制挡在前面。其一,host 在每条 `session/event` 上把活跃 session durable 地提到 workspace 账本最前(活动置顶),任何手动排序都会被下一次活动打乱——两种排序权威不可调和。其二,浏览区域被劈在两个包里:ui-sidebar 拥有列表、搜索和组头行,ui-workspace 只借一个 picker 坑放弹层;每加一个 workspace 域的对话框都要跨包接线,归属越来越拧。

## Decision

### 平铺视图与浏览态

group-by 菜单提供 WorkSpace / In one list 两种模式。平铺模式把所有 session(含 fork 子)一律作为顶层行,严格按 `updatedAt` 新→旧排序,不保持父子相邻;Intent 占位行渲染在列表首行。模式选择持久化在浏览器(`dsh.workspace.view`),刷新保持。

### 行交互

- session 行悬停 500ms 出详情卡(全名/相对时间/状态行;状态本期只有 running/idle 两态,枚举扩展待 wire 增补 status 字段)。卡片与行菜单互斥:菜单开启或拖拽进行中不出卡。
- session 行 … 菜单:Rename / Fork session / Delete session,本期纯视觉;workspace 组头 … 菜单:Rename(已接线)/ Delete workspace(纯视觉)。菜单鼠标移出即关。
- 支撑件:`Menu` 新增 label 条目、danger 行、`closeOnPointerLeave`;新增 `HoverCard`(portal 定位、开启延时、disabled 守卫)。

### workspace.rename

`workspace.rename({ workspaceId, title })`:title trim 后非空;同名 no-op 与重名查重都在 host 的 workspace 创建串行链内求值(与 create 共链,并发 create/rename 不能穿插出重名或乱序假成功),冲突回 `workspace-name-conflict`。落盘经 `setTitle` 的 mutate 通道,`domain/changed` 监听自动广播 `host/workspace-changed` 帧。UI 为标准 Modal,client 侧另做重名预检。

### 手动排序:insertSessionBefore 取代活动置顶

`session/event` → `touchSession` 活动置顶链整体删除;workspace 账本序改为纯手动拥有——新 session attach 时前插,显式重排走 `workspace.insertSessionBefore({ workspaceId, sessionId, beforeSessionId? })`(DOM insertBefore 语义:锚给了插锚前,缺省 append 到末尾)。实体只对不在账的 session/锚抛类型化的 `WorkspaceMoveInvalidError`,handler 仅把它映射为业务码 `workspace-move-invalid`,存储故障保持 internal。

UI 为组内 root 行的 HTML5 拖拽(仅 workspace 分组、非搜索态;fork 子随父不单独拖)。顺序权威完全在 host:drop 只发 RPC,client 零本地重排,视图靠响应体 upsert 与 changed 帧刷新;失败即无事发生。client 的 upsert 拒绝比已装载投影更旧(`updatedAt`)的快照,防迟到的一元响应回滚更新的帧。

### 壳/区域切分

ui-sidebar 缩为列几何壳:品牌行、折叠状态机、New Session、Settings,以及一个 `sidebar.workspaces` 洞;壳与区域的契约只有两个事实 `{ wide, expandSidebar }`。ui-workspace 全权拥有浏览区域(section header、搜索、分组树与平铺、全部 workspace 对话框、拖拽)及其 groupBy store;rail 态的搜索/新建图标也归区域,经 `expandSidebar()` 请求壳展开。picker 拆为核心件 `WorkspaceCreateFlow`(区域内直接组件组合)与薄包装 `WorkspacePicker`(继续填 ui-conversation 的 hero 坑);原 `sidebar.workspace` picker 坑与声明感知延迟注册随之删除。

## Alternatives considered

**保留活动置顶、拖拽仅作临时调整** —— 手动序在下一次 session 活动即被打乱,形同虚设;两种排序权威并存无法向用户解释。也考虑过「拖过一次即冻结该 workspace 的活动置顶」的折中,状态多一档、语义更难讲,直接删除更干净。

**排序报文用数字下标** —— `{ index }` 在拖拽窗口期会漂移:host 前插新 session(如 Intent 材料化)后同一下标指向别的行。锚点式 insertBefore 对前插与过滤投影天然免疫。

**drop 后乐观重排** —— client 先行重排需失败回滚,对象层多一块纠缠态;本地/局域网往返毫秒级,等 host 响应的简单方案肉眼无感。顺序权威单一化(完全信 host)后,前端永不发明顺序。

**rename 对话框留在 ui-sidebar(最小改动)** —— 正是问题本身:workspace 域的对话框散落在借来的坑里,每加一个(Delete 确认框将至)都重演跨包接线。评审中先议了「只挪 rename Modal」的中间态,最终裁定整个浏览区域归 ui-workspace,壳只留几何。

**平铺模式保持父子相邻成组** —— 与「严格按时间」矛盾(子新于兄则插不进相邻位),且平铺本意就是取消层级;拉平并禁用平铺下的拖拽(无持久化载体)更一致。

## Consequences

- 手动序是唯一的 workspace 账本序权威:用户排好的顺序不再被活动打乱;代价是「最近活跃浮到最上」的行为消失,活跃感知转由行内状态点与时间标签承担。`WorkspaceView.sessionIds` 的 wire 契约随之改为手动序措辞。
- 壳/区域两事实契约把 workspace 域的后续功能(Delete 确认、跨组移动、Ungrouped 收编)全部收进 ui-workspace 单包;ui-sidebar 不再随 session 列表功能演进。
- 平铺模式不支持排序与分组入口(建到指定 workspace 需切回分组视图),是拍板接受的范围收窄。
- session 菜单三项与 workspace Delete 的功能接线、状态枚举扩 wire,留待后续迭代。

## Testing

包级用例覆盖派生(deriveGroups/deriveFlat)、行组件、两处 apply 注册与透传、host 实体移位语义、rename/insertSessionBefore 的 RPC 实现与 fixture 桩;`apps/web` keyless snapshot 回归覆盖装配后的应用;交付验收另以 playwright(chromium headless)过 12 项清单(分组默认、平铺切换与持久化、hover 卡出现与抑制、双菜单、rename 全链、拖拽落盘),并对真 host 直打 wire 验证 rename 成功/重名拒绝/`workspace-move-invalid` 三径。
