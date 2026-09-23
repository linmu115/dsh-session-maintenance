# 旧地图资产逐条去向

旧修订：`d3fdbe3`；盘点日期：`2026-09-23`。完整来源、状态及处置理由保存在 `coverage-before-20260923.json` 和 `disposition-20260923.json`。

共 103 条：保留 48、合并 22、用户撤销 1、仅保留历史 32。16 条 history 和 1 条 journal 已恢复到新地图的“开发日志”；原始公开事件定位索引也已恢复。未绑定来源的 6 份过程草稿另由本次补录日志列出。其余历史条目留在 Git 旧修订及原报告，均不自动代表现行实现或验收。

“保留/合并”的目标 ID 指向当前地图；`map.md` 指当前首页。“用户撤销”只有旧自动登记工作区要求，后继为 `DEC-sync-authority`。

## requirement（7）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `REQ-detached-instance-attach-sync` | 实例先启动、引擎后接管与覆盖式真源同步 | retained | REQ-detached-instance-attach-sync |
| `REQ-learning-roundtrip` | 实验性学习会话双端交接与受控回收 | retained | REQ-learning-roundtrip |
| `REQ-maintenance-source-list` | 默认折叠的 Maintenance 真源名单 | retained | REQ-maintenance-source-list |
| `REQ-offline-vault-binding` | Maintenance 内按已登记实例管理 Vault 绑定 | retained | REQ-offline-vault-binding |
| `REQ-runtime-workspace-creation` | 实例新建工作区自动回写 | retired | DEC-sync-authority |
| `REQ-startup-recovery` | 点击启动即可恢复安全可回收的旧运行 | retained | REQ-startup-recovery |
| `REQ-sync-extension-navigation` | 两类同步并列与插件内信息页层级 | retained | REQ-sync-extension-navigation |

## decision（3）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `DEC-authority` | 真源原则和后续规格怎样继承 | retained | DEC-authority |
| `DEC-directory-connect-sync-authority` | 实例以目录选择接入，真源同步以同步工作区为界 | merged | DEC-sync-authority |
| `DEC-selection` | 这张地图选了哪些资料 | historical | map.md |

## interface（6）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `IF-extension` | 业务对象怎样交给 Maintenance 管理 | merged | IF-plugin-data |
| `IF-graph` | 主干图与固定来源怎样交接 | merged | IF-plugin-data |
| `IF-harness-adapter` | 平台读取、格式转换与续接合同 | merged | IF-endpoint-sync |
| `IF-native-context` | 释放材料怎样才算生效 | retained | IF-native-context |
| `IF-offline-vault-binding` | Maintenance 管理 Vault 绑定的独立授权合同 | merged | IF-vault-binding |
| `IF-runtime` | 宿主怎样准备和提交运行 | retained | IF-runtime |

## object（5）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `OBJ-extension` | 扩展对象、所属会话与写入权 | retained | OBJ-extension |
| `OBJ-graph` | 每会话主干、固定引用与披露日志 | merged | OBJ-plugin-graph |
| `OBJ-runtime` | 原生空间、运行租约与持久回执 | retained | OBJ-runtime |
| `OBJ-session` | 逻辑会话与工作区身份 | retained | OBJ-session |
| `OBJ-version` | 版本、谱系、检查点与续接 | retained | OBJ-version |

## module（16）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `MOD-business` | 业务插件／扩展数据适配器 | merged | MOD-plugin-adapters |
| `MOD-business-pages` | 公开业务信息页与贡献者生命周期 | retained | MOD-business-pages |
| `MOD-canonical` | 会话真源、导入与维护 | merged | MOD-core |
| `MOD-continuation` | Codex 续接与恢复作业 | retained | MOD-continuation |
| `MOD-dashboard` | Dashboard：阅读与维护入口 | merged | MOD-ui |
| `MOD-engine` | Engine：编排与持久事实 | merged | MOD-core |
| `MOD-extension-store` | 扩展存储、冲突与目录 | merged | MOD-plugin-adapters |
| `MOD-graph` | 固定引用与主干领域 | merged | MOD-plugin-adapters |
| `MOD-harness` | Harness／平台适配器 | merged | MOD-dsh-host |
| `MOD-harness-codex` | Codex：只读来源与原生续接 | merged | MOD-codex |
| `MOD-harness-dsh` | DSH：读取与原生格式族 | merged | MOD-dsh-host |
| `MOD-host` | 宿主接入：Provider、插件与桥 | merged | MOD-dsh-host |
| `MOD-instance-workspace` | 实例分类工作区策略与运行范围 | merged | MOD-endpoint |
| `MOD-native-context` | 原生上下文状态与释放核验 | merged | MOD-context |
| `MOD-reader` | 会话阅读与用户请求索引 | retained | MOD-reader |
| `MOD-runtime` | 运行准备、追加、关闭与恢复 | retained | MOD-runtime |

## 外部章节绑定（18）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `IF-extension-pages` | 公开业务页面与栏目注册合同草案 | retained | IF-extension-pages |
| `IF-instance-workspace-scope` | 实例有效工作区与会话范围合同草案 | retained | IF-instance-workspace-scope |
| `IMP-usage` | 现在怎样导入、运行与阅读 | merged | IMP-current-source |
| `IMP-versions` | 当前配套版本 | merged | IMP-current-source |
| `MOD-boundaries` | Engine、插件、Adapter 与 Launcher 的分工 | merged | DEC-authority |
| `REQ-adapter-families` | 两类 Adapter 独立的要求 | retained | REQ-adapter-families |
| `REQ-context` | 原生上下文管理的授权边界 | retained | REQ-context |
| `REQ-extension-pages` | 业务插件自主信息页与共享实例范围 | retained | REQ-extension-pages |
| `REQ-graph-removal` | 移除与撤销保持一致 | retained | REQ-graph-removal |
| `REQ-main-graph` | 每个接收会话自己的主干图 | retained | REQ-main-graph |
| `REQ-ownership` | 扩展条目归哪个会话 | retained | REQ-ownership |
| `REQ-product` | 维护哪些会话能力 | merged | map.md |
| `REQ-reader` | 长会话怎样阅读 | retained | REQ-reader |
| `REQ-runtime-space` | 持久原生空间的范围 | retained | REQ-runtime-space |
| `REQ-source` | 引用固定来源和完成位置 | retained | REQ-source |
| `VER-context` | 原生上下文实现的历史验证 | retained | VER-context |
| `VER-extension-pages-design` | 公开扩展页设计的文档检查 | retained | VER-extension-pages-design |
| `VER-reader` | 目录与阅读器的历史交付验证 | retained | VER-reader |

## implementation（24）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `IMP-codex-mirror-title` | Codex 镜像标题的原生冷读取 | historical | `d3fdbe3:docs/project/records/implementation/IMP-codex-mirror-title.md` |
| `IMP-context-progress` | 长历史发送预览与压缩进度 | historical | `d3fdbe3:docs/project/records/implementation/context-progress.md` |
| `IMP-current` | 当前源码已经做到哪 | historical | `d3fdbe3:docs/project/records/implementation/IMP-current.md` |
| `IMP-image-startup` | 图片升级后的历史恢复与启动兼容 | historical | `d3fdbe3:docs/project/records/implementation/image-startup.md` |
| `IMP-independent-components-20260920` | Maintenance 独立组件升级候选 | historical | `d3fdbe3:docs/project/records/implementation/independent-components-20260920.md` |
| `IMP-launcher-sync-directory` | 同步实例使用 Launcher 当前名称 | historical | `d3fdbe3:docs/project/records/implementation/launcher-sync-directory.md` |
| `IMP-learning-roundtrip` | 学习双向维护首版与使用边界 | historical | `d3fdbe3:docs/project/records/implementation/learning-roundtrip.md` |
| `IMP-lynn-adapter` | Lynn 组合与独立 GPT 数据映射 | historical | `d3fdbe3:docs/project/records/implementation/IMP-lynn-adapter.md` |
| `IMP-plugin-package-migration` | 测试实例插件迁移与源码发行包 | historical | `d3fdbe3:docs/project/records/implementation/plugin-package-migration.md` |
| `IMP-recovery-archive` | 纯准备尾部恢复与宿主归档还原 | historical | `d3fdbe3:docs/project/records/implementation/IMP-recovery-archive.md` |
| `IMP-reference-identity-recovery` | 重启后引用身份恢复与旧链接定位 | historical | `d3fdbe3:docs/project/records/implementation/reference-identity-recovery.md` |
| `IMP-reference-send` | 模型设置误触发派生会话修复 | historical | `d3fdbe3:docs/project/records/implementation/reference-send.md` |
| `IMP-scope-business-pages` | 工作区策略、运行快照与公共信息页当前实现 | historical | `d3fdbe3:docs/project/records/implementation/scope-business-pages.md` |
| `IMP-startup-gate-split` | 启动门与普通插件库存分离（MNT-001） | historical | `d3fdbe3:docs/project/records/implementation/startup-gate-split.md` |
| `IMP-startup-recovery` | 启动时自动处理已退出的旧运行 | historical | `d3fdbe3:docs/project/records/implementation/startup-recovery.md` |
| `IMP-sync-ui-release` | 同步与扩展页面修复及 .39 待激活状态 | historical | `d3fdbe3:docs/project/records/implementation/sync-ui-release.md` |
| `IMP-vault-folder-picker` | Vault 绑定文件夹窗口与等待期限 | historical | `d3fdbe3:docs/project/records/implementation/vault-folder-picker.md` |
| `INT-annotation` | Core 的固定引用、镜像与原生接入 | historical | `d3fdbe3:docs/project/records/modules/adapters/business/integrations/annotation.md` |
| `INT-business-directory` | 业务 Adapter 已知格式与接入目录 | historical | `d3fdbe3:docs/project/records/modules/adapters/business/connected.md` |
| `INT-gpt-format` | GPT 兼容插件的扩展数据 Adapter | historical | `d3fdbe3:docs/project/records/modules/adapters/business/gpt-compat.md` |
| `INT-harness-directory` | 平台 Adapter 已知实现与调用者 | historical | `d3fdbe3:docs/project/records/modules/adapters/harness/connected.md` |
| `INT-obsidian` | Obsidian：链接与引用分别接入 | historical | `d3fdbe3:docs/project/records/modules/adapters/business/integrations/obsidian.md` |
| `INT-stickers` | 贴纸：对象、会话与引用接入 | historical | `d3fdbe3:docs/project/records/modules/adapters/business/integrations/stickers.md` |
| `INT-thoughtdag` | ThoughtDAG：主干领域与上下文视图 | historical | `d3fdbe3:docs/project/records/modules/adapters/business/integrations/thoughtdag.md` |

## verification（7）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `VER-adoption` | 本次地图整理的验证范围 | historical | `d3fdbe3:docs/project/records/verification/VER-adoption.md` |
| `VER-browser-431-edge` | Edge 登录恢复与 DSH 请求头修复待安装 | historical | `d3fdbe3:docs/project/records/verification/browser-431-edge.md` |
| `VER-learning-roundtrip` | 学习交接闭环与 Codex 上下文验证 | historical | `d3fdbe3:docs/project/records/verification/learning-roundtrip.md` |
| `VER-scope-business-pages` | 工作区范围与公共信息页的本地验收 | historical | `d3fdbe3:docs/project/records/verification/scope-business-pages.md` |
| `VER-startup-gate-split` | 启动门分离的测试与边界证据 | historical | `d3fdbe3:docs/project/records/verification/startup-gate-split.md` |
| `VER-startup-recovery` | 启动恢复的测试、安装与真实运行验收 | historical | `d3fdbe3:docs/project/records/verification/startup-recovery.md` |
| `VER-sync-ui-release` | 本轮真实UI、独立安装与未激活边界 | historical | `d3fdbe3:docs/project/records/verification/sync-ui-release.md` |

## history（16）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `HIST-context-progress` | 让长历史压缩等待可见 | retained | HIST-context-progress |
| `HIST-extension-pages-vault-binding` | 公开业务栏目与实例同步范围的确认 | retained | HIST-extension-pages-vault-binding |
| `HIST-gpt-extension-boundary` | 将 GPT 插件误当成 Harness 的纠正过程 | retained | HIST-gpt-extension-boundary |
| `HIST-image-startup` | GPT 图片升级后 Launcher 阻塞的恢复过程 | retained | HIST-image-startup |
| `HIST-learning-association-repair` | 学习关联修复与普通同步自动排除 | retained | HIST-learning-association-repair |
| `HIST-learning-roundtrip` | 学习会话双向维护的范围收敛与回收锁 | retained | HIST-learning-roundtrip |
| `HIST-learning-roundtrip-implementation` | 学习交接首版实现与隔离闭环验证 | retained | HIST-learning-roundtrip-implementation |
| `HIST-maintenance-source-list` | 真源同步名单折叠与选择布局 | retained | HIST-maintenance-source-list |
| `HIST-manual-engine-start` | 引擎手动启动入口与旧运行回收 | retained | HIST-manual-engine-start |
| `HIST-offline-vault-binding` | Vault 绑定从在线 DSH 动作迁到 Maintenance 管理 | retained | HIST-offline-vault-binding |
| `HIST-recovery-archive-title` | 重启重复会话、归档复现与旧派生标题的修复过程 | retained | HIST-recovery-archive-title |
| `HIST-recovery-regression` | 升级遗漏启动恢复补丁与外部浏览器目录失败 | retained | HIST-recovery-regression |
| `HIST-reference-identity-recovery` | 派生会话引用在重启后失联的修复历程 | retained | HIST-reference-identity-recovery |
| `HIST-reference-send` | 模型设置误触发派生会话修复 | retained | HIST-reference-send |
| `HIST-settings-entry` | DSH 设置面板收敛到完整看板入口 | retained | HIST-settings-entry |
| `HIST-startup-recovery` | 从未回收会话报错到自动恢复启动 | retained | HIST-startup-recovery |

## journal（1）

| 旧 ID | 原标题 | 去向 | 当前入口 |
| --- | --- | --- | --- |
| `JOURNAL-20260922-lynn-adapters` | Lynn 数据映射与 GPT 独立适配 | retained | JOURNAL-20260922-lynn-adapters |
