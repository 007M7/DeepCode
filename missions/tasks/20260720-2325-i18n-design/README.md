# Web GUI 多语言（i18n）设计 — 任务理解

> 归档状态注（2026-07-21）：本档为 **i18n 设计归档**（二稿封存待恢复）；执行人后续另单完成的 P0-2 贡献者规范见 dd28a5019（packages/client/AGENTS.md），两任务无关联，防混淆。

- **角色**：i18n-design owner（常驻 teammate，前身 rfc-edit；归档遗产在 missions/tasks/20260719-2339-web-cordis-design/ 与 .agents/notes/）。
- **交付物**：本目录 design.md（中文，供用户 review）。**纯设计文档作业，零源码改动零 commit**——gate-finisher 正在同一工作树跑 check:pre-push 终验，可能落门禁修复刀，我只落盘文档不碰源码。
- **背景**：用户点题「Web 多语言」，无更多约束；设计空间由我铺开，分叉点列清单留用户拍板，不替拍。

## 必须覆盖的设计面（派发方指定）

1. **现状盘点**：web-ui 组件中文产品文案的数量与分布（grep 中文 JSX 文案）；host 侧是否下发用户可见文案（RpcError message、presenter 产的 view.title 均为英文——要不要进翻译面是真问题）。
2. **技术选型**：react-i18next / react-intl(FormatJS) / lingui / 自研轻量 hook 四路对比。约束：本仓零依赖偏好（i18n 是运行时依赖，比 dev 依赖敏感度更高，「自研 vs 引库」成本收益要摆透）；bundle 体积；key 的 TS 类型安全；vite 契合。
3. **架构接线**：字典文件位置（web-ui 包内 locales/？）；语言状态位置（zustand ui slice + localStorage，对齐 dsh.theme 模式，key 建议 dsh.locale）；默认语言与检测（navigator.language？）；组件消费形态（useT() hook？纯 props？——须经得起「组件是耗材会重做」红线）。
4. **范围边界**：v1 是否只做 web-ui 静态文案（中/英）；host 下发内容（错误码→本地化映射表放 client？）、日期/相对时间 locale（formatRelative 现状）、将来 cordis 插件文案（一句预留，挂 DSHClientProxy/registerSlot 线）。
5. **与 docs 双语体系的关系**：docs zh/en 配对（.i18n.yaml）是文档 i18n，web 产品文案是运行时 i18n，两套各管各的——一句话划清。
6. **妥协台账三段式**（触发条件→返工点→预埋要求）+ 分叉清单（选型、范围、默认语言等）留用户拍。

## 纪律

- 小步落盘：README → 现状盘点批 → 选型对比批 → 架构+边界批，每批一句 SendMessage 回执；批间清收件箱；落盘间隔 ≤5 分钟。
- 遵守 missions/conventions.md（已读）：设计先行、注释规矩与我无关（零源码）、妥协台账三段式（第 12 条）、web 纯呈现层红线（第 18 条）参与范围界定。

## 工作日志

- 2326 建目录落 README。
- 2335 现状盘点批：web-ui ~50 条中文文案/15 文件成表；host 三类下发文本（RpcError/agent-error/tool 卡 view）可译性分档；theme/store/vite（apps/web）既有模式核实。
- 2342 选型批：四路对比表 + 自研 vs 引库成本收益正面摆，推荐自研查表（方案 D）。
- 2350 接线+边界批：§3（web-ui/src/i18n/ 字典 TS 模块、dsh.locale 照抄 theme 模式 + useSyncExternalStore、useT()/util 显式 locale）、§4 范围、§5 与 docs 双语划清、§6 六条台账、§7 五个分叉；§0 结论速览回填，标记完稿待 review。
- **口径变更（三单纠向后补消费）**：用户砍掉四路选型对比，改为「读 deepseekchat 实现照它设计」。教训：批间未清收件箱，做了被砍的活——已在纪律里加粗。
- 0018 chat 侦察批：§2 重写——deepsuite-frontend `packages/i18n` 自研（运行时 ~490 行 + ds-i18n 飞书 codegen）、`I18n = typeof zh_CN` 类型钉、`t.key` 属性消费、preference/'system' 分离存 zustand、file-error-code 错误码→key 先例、dayjs 82 语映射、@deepseek/ui LocaleProvider；原对比压缩为 §2.7 备考（上游自研印证原推荐，无冲突）。
- 0026 适配设计批：§3 重写为「它的 X→我们的 Y」适配总表（抄形态裁规模：字典钉型/t.key/preference 三值照抄；codegen/82 语/懒加载/dayjs/%r 格式化器裁掉）+ 落点形态 + **零新增依赖清单**；§4/§6/§7/§0 同步对齐（台账扩至八条，分叉收敛为四个）。
