# jsdom E2E 行为车道（roadmap T4）

> owner：web-test。
> **口径变更（2026-07-21 01:3x 用户亲拍，覆盖旧口径）**：jsdom 线**也要保证覆盖率**——web-ui 目标=摘 exclude 进 per-file 100% 门（防御臂照 v8-ignore 纪律）。断言口径不变（行为级，不钉实现细节/布局 DOM），变的是铺量。执行序：行为主链路批→coverage 实测出缺口清单回执 main→分批补齐→数字达标那批才摘 exclude（避免中间态红全仓门）。壳并行风险升级：组件文件被壳刀弄红照旧对落盘校准；AppShell 新壳文件的覆盖等他刀落完再补。
> ~~旧口径：不追覆盖率；web-ui exclude 长期不动~~（作废；此前 b 档档案「触发条件=组件重做完成」一并作废）。

## 目标场景（对话流主链路）

挂 App→列表出现→选会话→历史渲染→发消息→流式 partial 追加→终态定格→tool 卡三型回退→断线重连条出现/消失。

## 设计要点

- **数据面**：bootWebRuntime({mode:'fixture'})——fixture 打字机 80ms/帧走真实时钟，jsdom 下可 await（vi.waitFor 轮询 DOM 文本）；或手挂 FakeApiClient 控时序（断线重连场景用 failStreams）。倾向前者为主（真 E2E 味），后者只给重连场景。
- **防撞车边界**（arch-session 壳三刀并行中）：零布局 DOM 断言（不断 class/容器嵌套），只断文本出现/元素状态（disabled/aria）；不 import AppShell/侧栏文件；挂 App 若被壳刀改形，对落盘代码校准断言语义不变。
- 依赖：RTL/jsdom 已在 root devDeps（005cff814 落的），零新增。
- 基线纪律：不弄红存量 test:gui；--no-verify commit 不 push。

## 批次记录

| 批 | 内容 | 状态 |
|---|---|---|
| 1 | 建档+读壳 design 防撞面 | ✅ |
| 2-3 | conversation-flow.spec.tsx（3 用例合刀）：主链路（挂 App→列表→选 fx-alpha→历史 turn59→停幻影 run→发送乐观清稿→流式锁输入→回声定格解锁）+ 历史 tool 卡与常驻审批占位 + 停止中断（打字机中途停→已中断/已停止标记+解锁） | ✅ |
| 4 | reconnect-banner.spec.tsx：null 连接中不显示→connected 不显示→reconnecting 条出现→恢复清除（驱动 store 切片=controller 的成文契约，contra fixture 无法外破自身流） | ✅ |

## 实况笔记

- commit：conversation-flow + reconnect-banner 两 spec 一刀（4 用例，test:gui 全量 233 绿）。
- fixture 打字机走真实时钟：waitFor 轮询 DOM 文本即可，单用例超时放 60s（CI 缓冲），实测全套 ~3s。
- 坑：①jsdom 无 matchMedia，App 挂载踩 ThemeToggle——模块级 stub 一次；②React 外的 store.setState 驱动组件要包 act()；③fx-alpha 开局 running=true（fixture 列表材料），发消息前先点停幻影 run——用例里做成条件步防 fixture 语义漂移。
- 防撞车执行情况：零 class/容器断言（全部 findByText/findByTitle/role+disabled）；未 import 壳文件（App 本体挂载不算——壳刀改 App 组成时按落盘校准，断言语义不动）。
- ~~T4 尚欠~~：三型 tool 卡逐型断言已随覆盖率梯队钉齐（view-states + branch-tails 两 spec：terminal/diff/generic 各多形态、混 tag 半边、registry 压制）；重连全链版裁决=不做（reconnect-banner 4 断言已覆盖对应分支，ConnectionController 掉线重连语义在 web-runtime connection.spec 有全链用例，jsdom 层再串一遍无增量——记台账即此条）。

## 覆盖率梯队记录（口径升级后）

| 梯队 | spec | 用例 | 结果 |
|---|---|---|---|
| 1 | rpclog-panel | 8 | 面板三件 ~0%→81-100 |
| 2 | conversation-pieces | 14 | InputBar/AssistantMessage/JsonBlock/MessageItem/ThemeToggle/SessionListContainer 全拉满或近满 |
| 3+尾 | view-states + branch-tails | 13+28 | ConversationView 状态/翻页锚定补偿/force-bottom/follow-off、ToolCallCard 全臂、LogRow 方向、registry 卫生、mount 胶水、interval tick |
| 终 | 0770d23ba | — | web-ui 摘 exclude 进 per-file 100% 门 |

**终批要点**：①coverage include 加 .tsx；②exclude 从 `packages/client/web-ui/src/**` 收窄到单文件 `index.tsx`（盘上死重复——与 mount.tsx 逐字节相同、零 import，走 bin.ts 入口胶水先例并注明；删除权归属地）；③v8-ignore 清单全带真实理由（ref-null 卫 ×6、css-module 键卫、禁用态点击卫、both-null 臂、dense-array 卫 ×3、fixture 打字机 text-only 的 view-present 臂——最后这条注明「view 词汇由 turn60-62 历史样本覆盖」）；④期间 tool-card 批的 src 漂移新增 7 处失覆盖点当场加注。全仓 test:coverage 实跑：client 侧零报错；host 侧 apiproxy/runtime/webserver 的红是 coverage-fixer（gate-finisher）名下在途活，非我批次引入。
