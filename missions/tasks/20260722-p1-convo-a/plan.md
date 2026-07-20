# convo-a 施工档案（ui-conversation 骨架半；包 owner）

> 契约：api-contracts v3 §7（法律）；上游 §2/§4/§5。业务规格 plugins.md §2.2/§2.9/§0.1；机制 architecture.md §8/§11/§13/§16。
> 分工：convo-a=service+骨架组件+公共类型；convo-b=消息流+toolviews+apply 接线（#13 拆分后）。

## 1. 文件边界（convo-a 拍板 2026-07-22；apply 段后让渡 convo-b）

| 路径 | owner |
|---|---|
| `src/index.ts`（node 半边）、`src/client/index.ts` 公共类型/re-export 段 | convo-a |
| `src/client/index.ts` 的 apply+inject 段 | convo-b（#13 拆分让渡） |
| `src/client/service.ts`、`src/client/skeleton/` | convo-a |
| `src/client/chat/`、`src/client/toolviews/` | convo-b |
| tests/：service*/skeleton* 归 a；chat*/toolview* 归 b | 按前缀 |

## 2. 落库记录（全绿收口 2026-07-22 凌晨）

| 刀 | commit | 内容 |
|---|---|---|
| A 双入口拆分 | 3083be6ad | src/client/ 结构、node 半边空 apply、/client types、tsdown、registry 随迁 |
| B service | c542144a8 | ConversationService 全量+invariant 伴生+8 单测 |
| D1 InputBar | 8dff04108 | legacy 平移+--dsw-* token+hero/composer variant+accessory 槽 |
| D2 DetailsPanel | 80a1ca341 | selection→args/result 极简+运行中/窗口外/错误三态 |
| D3 EmptyState | 09ce4f511 | hero+cwd 下拉（list 派生+新目录）+startSession 提交+失败留稿 |
| D4 ConversationRoot | 0d0e0fb4b | 面包屑 ancestry+ViewSwitcher（views uSES）+composer 接 promptError |
| D5 导出+验收 | 5380467f1 / 71aaca638 | index 导出；skeleton jsdom 8 测 |

## 3. 实现要点（后来者须知）

- **scope 寻址**：ConversationService extends cordis Service；tracker 令 `this.ctx` 重绑 caller ctx，方法内 scopeOf 读会话标。**经 scope 取服务必须 `scoped.get('conversation')`**——属性访问走 fiber 拓扑链（scope fiber 无 inject）必 throw。
- **per-scope 账**：selection/drafts Map<SessionId,store>，首次经 scoped ctx 访问惰性建；`this.ctx.effect`（tracker 已重绑=scope fiber）注册清账，scope 拆除级联收回。
- **drafts persist 手写**：web-react persist 中间件对 primitive state 会 object-spread 把字符串拆成 {0:'h',…}（实测），故 drafts 直接 localStorage 读写（空串=removeItem，re-mint 重水化）。已报 fw-react 评估修引擎。
- **startSession**：create→await 一个微任务（manager notifier flush，list 投影落地）→layout.open→scoped.get('conversation').send。
- **组件注入面**：四组件零框架 import；ConversationRoot 的 views 面吃 uSES 三件套（svc.views/subscribeViews/viewsVersion，cache 引用稳定）。
- Service 类字段禁 `#` 硬私有（tracker 代理下破）；可变状态收进普通对象一跳可达（viewsState cell）。
- **值 import 必须走 externals 的 specifier 形态**（W5 P0 实证，585671106）：client 半边裸包名值 import（如 `from '@deepseek-ai/dsh-client-runtime'`）不在 CLIENT_EXTERNALS（只登记 `/client` 子路径），tsdown 内联出第二个模块实例——scopeOf 的私有 Symbol 双实例不相认，浏览器 scope 恒 undefined；node 单测单实例解析抓不到。type import 无害。已提议 bundle 门禁（产物含非 externals 的 @deepseek-ai/* 模块体=fail）。

## 4. 未决/后续

- ~~EmptyState 挂载~~：已收口——root 坑 `conversation.empty`，register+inject 归 convo-b 接线刀（f95b77600）。
- Header 按钮排（Fork/Session log/I/O Details）：P-I 无功能不落占位钮，随功能落。
- drafts 手写 localStorage 可回迁引擎 persist（fw-react 已修 primitive bug，d032b0fb1）；回迁时旧 key 清一次或换 name。不急做。

## 5. 接线收口（convo-b f95b77600，owner 核查通过）

apply.ts 立新家（index 只加一行 re-export）；watch 驱动 `session.open()` 放 conversation 坑 inject 工厂（per-entry×session 一次=观看信号，幂等自恢复，不挪 SessionProvider——那层归壳，不该认识 Session 操作面）；乐观清稿回填带空稿检查防覆盖新输入。包内格局定型：index（类型+导出）/service+skeleton 归 a；apply+chat+toolviews 归 b。全包 62 测绿。

## 6. 事故记档

- **e0208b6d7 混刀**（2026-07-22，main 验收提醒）：`git add packages/client/ui-conversation/src/client/skeleton/` 前的一次宽 add 把 convo-b 在盘的 ChatView.tsx/.module.css 在途件扫进本刀（终树正确、内容零冲突，仅历史归属混淆；convo-b 自认同责）。不返工。教训=add/commit 一律 pathspec 精确到文件，同包双人期间任何目录级 add 都是雷（今晚全队第三起同型）。
