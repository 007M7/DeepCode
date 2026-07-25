# Workspace GUI 收尾备忘

## 产品改动

- 用户要求“去掉功能”时，先拆开视觉入口、可访问性语义和响应行为分别确认。本次 composer 加号保留原样和 `Add attachment` 标签，只在组合层停止传入 Workspace 回调；不要删除按钮、改样式或把它禁用。
- 临时交互不应上浮到 React 呈现层。Session/Workspace Intent、首次消息保留和 materialize 重试归 runtime 对象与 service；组件只接收标准 action、hooks 和纯呈现状态。
- RFC、测试名称和 PR 描述只写最终产品语义，不保留 `reconcilePublishedDraft`、`pendingCwd` 等已经撤销的中间方案。

## Snapshot 与测试定位

- `apps/web/tests/**/*.snapshot.ts` 验证 built application，需用 `DSH_EXAMPLE_MODE=lib`，并确认相关 `lib/` 已由当前源码构建；普通 source-mode Vitest 通过不能替代它。
- 对 runtime 管理的受控输入执行 `fireEvent.change` 后，必须 `waitFor` 输入值回显再点击发送，否则发送可能读取旧的空 prompt。
- 页面中 Workspace 与 Session 可以同名，禁止用无作用域的 `findByText` 定位。先用 `within` 锁定 Sessions tree、计数或对应 group，再找目标行。
- 新 push 后先看 assembled snapshot 是否真正跑过；本地 focused snapshot 通过后仍以 `gh pr checks` 的 artifact job 为准。

## Coverage 收口

- 测试筛选和 coverage 筛选是两件事。用 owning tests 配合逐个 `--coverage.include='<source-file>'`，先拿到真实未覆盖行和分支，不要直接反复跑全仓 coverage。
- 多个 coverage 进程并发时必须给不同的 `--coverage.reportsDirectory`，否则报告目录互相覆盖。各 worker 完成后再跑一次合并后的精确 coverage，确认共享 worktree 的改动组合起来仍为 100%。
- 全仓 coverage 若先被无关测试超时打断，不能把它当作目标文件的结论；先用精确 include 修本分支缺口，再让 CI exhaustive coverage 验证整体。
- Coverage 测试仍要描述行为，不写“为了覆盖某分支”的注释。不可达分支才使用已有规范允许的 `v8 ignore`，可达分支补真实行为测试。

## 并发与提交

- Coverage 适合按不相交写区并发：例如 Sidebar tests、Workspace picker tests、connection/storage tests。派工时明确“只改 tests、不改 src、不 commit、不得回滚他人改动”。
- 不直接信任各 worker 的单独结果；主会话审查 diff、运行合并后的 focused coverage、清理生成报告，再统一 commit。
- 推送前按 `dsh-pre-push-checks` 选择最小充分验证，不重复已经通过的检查；正常 push 让 pre-push typecheck 运行，并核对本地 HEAD 与远端 ref 一致。
- 生成的 `.coverage/` 只属于本地诊断。环境拒绝 `rm -rf` 时，依次使用 `find .coverage -type f -delete` 和 `find .coverage -depth -type d -empty -delete`；不要让报告进入 commit。

## GitHub 与 CI

- GitHub 操作统一走 `gh`，并从 git 配置注入代理：`proxy="$(git config --get http.https://github.com.proxy)"; https_proxy="$proxy" http_proxy="$proxy" GH_PAGER=cat ~/.local/bin/gh ...`。不要改用网页。
- 每次 push 都会产生一轮新 checks；旧轮次的失败不能代表当前 HEAD。先确认 run 对应当前提交，再拉失败日志。
- `gh run watch` 只监视一个 workflow。最终必须用 `gh pr checks` 汇总 CI、e2e、sandbox 和 Windows 等独立 workflow；偶发平台失败先等当前 HEAD 重跑结果，不预先修改无关代码。
- PR base 和 description 在最终 push 后再次用 `gh pr edit --base ... --body-file ...` 同步。PR 描述应包含最终产品动线、架构边界和实际运行过的验证，不写仍待执行的承诺。
- Review thread 用 GraphQL/`gh api` 检查 `isResolved` 和已有回复，避免对已经解决的旧实现评论重复修复。
