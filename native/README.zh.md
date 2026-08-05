# native/

[English](README.md) | 中文

`node-addon-landlock-run` 的真源；它是供 harness 使用、先施加 Landlock 自限再执行命令的启动器。[`landlock-run/` workspace](landlock-run/README.md)负责其架构、包家族、平台支持、开发工作流和发布流程。独立仓库是发布镜像。

## 发布镜像

| 目录 | 镜像仓库 | 最近导出的版本 | Commit |
|---|---|---|---|
| `landlock-run/` | https://github.com/deepseek-harness/node-addon-landlock-run | `v0.0.1` | `614f7fd7dc11e6eaceefba9e7ff1fbe28b51ba22` |

该子树是自包含的 pnpm workspace，不属于 harness workspace。[启动器发布参考](landlock-run/docs/release.md)负责导出和发布工作流。镜像不得发生分歧：下次导出前，必须把任何直接施加于镜像的热修复移植回此处。
