# Agent Note: 移除首次启动内测声明

Status: implemented

[English](2026-08-13-remove-first-run-beta-notice.md) | 中文

## 问题

GUI 每次首启都会先显示占满视口的内测声明：内部测试的定位表述，加上通过 `DSH_TELEMETRY_MODE` 开启 Session Log 上传的说明。会话遥测在 mode 未设置时已解析为 `DISABLED`（[遥测默认关闭](../feature/2026-08-10-telemetry-default-off.md)），因此引导流程中关于遥测的全部内容就是一段教用户如何开启的提示，而内部测试的定位表述本身也不应出现在发布版本里。

## 决策

首启声明从组装后的产品中整体移除，而不是改写。`ui-settings-general` 不再注册任何 `settings.onboarding` 步骤；声明组件、其持久化确认 store、文案所有者文件和 locale 键全部删除。`settings.onboarding` 协调器及其接管式展示阶段保留（[有序引导](../feature/2026-07-30-versioned-gui-welcome-onboarding.md)），按条件显示的 DeepSeek 凭据步骤是当前唯一的注册方。宿主端仍注册 `ui-onboarding` 设置 namespace：其中的 `welcomeNoticeVersion` 字段让 `$DSH_HOME/settings.yaml` 中已写入的确认记录保持有效，没有任何代码读取或写入它。遥测的开启仍是显式的部署环境变量选择，记录在仓库 README 中；产品界面不出现任何关于开启遥测的提示。

## 曾考虑的替代方案

**保留声明，只删除其中的遥测段落。** 不予采用：发布版本不应呈现的正是内部测试的定位表述本身，而一个没有实质内容的强制首启插页只剩下打扰。

**改为询问上传同意（版本化的同意步骤）。** 本次发布不予采用：首启询问是否开启上传仍然是一个遥测提示。未来的同意流程可以通过保持不变的 `settings.onboarding` seam 注册，并使用新的版本化字段做重新确认。

**连 `ui-onboarding` namespace 一起注销。** 不予采用：既有设置文档已经包含该分节，而设置 seam 会用已注册的 namespace 校验存储文档；保留注册就能让这些文档继续有效，且没有额外成本。

## 后果

全新 profile 在缺少 DeepSeek 凭据时直接进入凭据步骤，凭据已配置时直接进入产品，两种情况都没有占满视口的声明。组装级引导场景从凭据步骤开始，远程声明场景随功能一并删除，goal-bar fixture 继续禁用设置外壳，因为 fixture API 客户端会拒绝设置请求。将来若要恢复首启声明，需要新的引导注册和新的版本化字段；保留的 namespace 不会复活旧的确认语义。
