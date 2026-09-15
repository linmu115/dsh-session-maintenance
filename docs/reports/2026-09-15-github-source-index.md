# 当前 RC2 源码与使用说明索引

2026-09-15：按运行副本的完整配套清单，整理 17 个仓库的当前开发分支与 README。下方链接直接定位本轮更新所在分支；已有仓库的 main 不因这次源码推送自动更新。每个仓库保留本地开发提交历史，并单独提交本次 README 修改。

文档包含当前功能、实际操作入口、安装/构建前置条件、组件依赖与版本，以及删除、归档和上下文披露等规则。中英文 README 同步更新（原仓库提供多语言时）。原有交付报告保留其日期和当时状态；例如旧报告中的“仅本地提交”描述该报告生成时的发布状态。

| 仓库及使用说明 | 当前源码版本 | 分支 | 可见性 |
| --- | --- | --- | --- |
| [dsh-annotation-core](https://github.com/linmu115/dsh-annotation-core/blob/codex/rc2-session-context-graph/README.md) | 0.3.12-rc2.9 | `codex/rc2-session-context-graph` | 公开 |
| [dsh-session-sticker-board](https://github.com/linmu115/dsh-session-sticker-board/blob/codex/rc2-session-context-graph/README.md) | 0.7.3-rc2.15 | `codex/rc2-session-context-graph` | 公开 |
| [dsh-sidechat](https://github.com/linmu115/dsh-sidechat/blob/codex/rc2-session-context-graph/README.md) | 0.4.7-rc2.9 | `codex/rc2-session-context-graph` | 公开 |
| [dsh-obsidian-bridge-lifecycle](https://github.com/linmu115/dsh-obsidian-bridge-lifecycle/blob/codex/rc2-session-context-graph/README.md) | 0.3.3-rc2.13 | `codex/rc2-session-context-graph` | 公开 |
| [dsh-obsidian-reference-adapter](https://github.com/linmu115/dsh-obsidian-reference-adapter/blob/codex/rc2-session-context-graph/README.md) | 0.3.4-rc2.13 | `codex/rc2-session-context-graph` | 公开 |
| [dsh-obsidian-session-reference-suite](https://github.com/linmu115/dsh-obsidian-session-reference-suite/blob/codex/rc2-session-context-graph/README.md) | 0.3.4-rc2.15 | `codex/rc2-session-context-graph` | 公开 |
| [dsh-session-maintenance](https://github.com/linmu115/dsh-session-maintenance/blob/codex/rc2-session-context-graph/README.md) | Engine 0.1.33-rc2.18 / 插件 0.2.26-rc2.14 | `codex/rc2-session-context-graph` | 公开 |
| [obsidian-deepharness-bridge](https://github.com/linmu115/obsidian-deepharness-bridge/blob/codex/dsh-0-1-5-rc2/README.md) | 0.6.4-rc2.6 | `codex/dsh-0-1-5-rc2` | 公开 |
| [dsh-codex-runtime](https://github.com/linmu115/dsh-codex-runtime/blob/codex/rc2-session-context-graph/README.md) | Runtime 0.2.0-dev.17 / Support 0.1.0-dev.9 / Dispatch 0.1.0-dev.5 / Team Adapter 0.1.0-dev.6 | `codex/rc2-session-context-graph` | 私有 |
| [thoughtdag](https://github.com/linmu115/thoughtdag/blob/codex/rc2-maintenance-graph/README_ZH.md) | 0.4.14-rc2.8 | `codex/rc2-maintenance-graph` | 公开 |
| [dsh-better-sidebar](https://github.com/linmu115/dsh-better-sidebar/blob/fix/rc2-preserve-layout-20260912/README.md) | 0.19.2-rc2compat.1 | `fix/rc2-preserve-layout-20260912` | 私有 |
| [dsh-better-sidebar-jupyter](https://github.com/linmu115/dsh-better-sidebar-jupyter/blob/codex/rc2-sidebar-20260912/README.md) | 0.2.5-rc2.1 | `codex/rc2-sidebar-20260912` | 私有 |
| [dsh-agent-teams](https://github.com/linmu115/dsh-agent-teams/blob/codex/dsh-0-1-5-rc2/README.md) | 0.1.17-rc.2.codex.4 | `codex/dsh-0-1-5-rc2` | 公开 |
| [dsh-obsidian-bridge-protocol](https://github.com/linmu115/dsh-obsidian-bridge-protocol/blob/codex/dsh-0-1-5-rc2/README.md) | 0.3.3-rc2.1 | `codex/dsh-0-1-5-rc2` | 公开 |
| [dsh-resource-management](https://github.com/linmu115/dsh-resource-management/blob/codex/dsh-0-1-5-rc2/README.md) | 0.3.8-dev.4 | `codex/dsh-0-1-5-rc2` | 公开 |
| [dsh-session-context-menu](https://github.com/linmu115/dsh-session-context-menu/blob/codex/dsh-0-1-5-rc2/README.md) | 0.3.3-rc2.1 | `codex/dsh-0-1-5-rc2` | 公开 |
| [dsh-settings-scroll-fix](https://github.com/linmu115/dsh-settings-scroll-fix/blob/codex/dsh-0-1-5-rc2/README.md) | 0.2.3-rc2.1 | `codex/dsh-0-1-5-rc2` | 私有 |

Better Sidebar、Jupyter 扩展与设置滚动修复是本次新建的私有仓库；其他项目保留已有可见性。私有仓库链接需要所有者或获授权账号登录，公开仓库中的链接不授予访问权限。原作者和许可信息保留在相应仓库。

此清单涵盖这套 RC2 插件组合及 Obsidian Vault 伴侣；Runtime 仓库还包含 Support、Dispatch 和 Team Adapter。Maintenance 同仓包含 Engine、Dashboard、会话版本 Adapter 和 DSH 插件。停用的旧同步项目或不在当前副本中的独立工程不作为本次组合发布。

## 安装范围

这次更新是 GitHub 源码和说明同步，不等同于 npm 发布、GitHub Release 资产发布或再次部署。已有副本运行产物保持原交付版本；参见[生命周期交付记录](2026-09-15-graph-reference-lifecycle-release.md)。README 中的打包命令使用本地源码，某些工作树仍需配套 RC2 Session 构件或本地 file: 依赖。仅克隆源码、安装上游 latest 或复制一个插件目录，不能替代整组宿主/插件验证。

使用系统功能先阅读[Maintenance 总览](../../README.md)，图与上下文规则见[设计与功能需求](../superpowers/specs/2026-09-10-session-context-graph-requirements.md)。
