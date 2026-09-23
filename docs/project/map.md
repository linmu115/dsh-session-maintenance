# Session Maintenance 项目地图

项目 ID：`0d05f813-7097-47d9-9e88-3d523bb537d6`。本地图于 2026-09-23 依据当前源码重建；源码核对起点为 `d3fdbe3`。它描述此仓库现在的职责、接口和已知缺口，不把历史测试、发行包版本或健康检查写成当前实例验收。

## 项目做什么

Maintenance 保存逻辑会话、工作区归属、不可变版本、来源、派生关系和同步回执。Codex 原日志仍由 Codex 拥有；DSH 原生会话由宿主拥有。同步时，平台适配器把各自格式转换为规范事件并处理物理读写。Maintenance 忠实保存插件数据的 namespace、类型、记录身份与原值，不解释插件图、引用或贴纸的业务含义。

## 从哪里开始读

| 问题 | 当前入口 |
| --- | --- |
| 核心应与什么解耦 | [[REQ-boundary]]、[[ISS-remaining-coupling]] |
| 会话身份、版本与真源怎样保存 | [[MOD-core]]、[[IMP-current-source]] |
| 工作区加入、启动对齐和运行期回传 | [[MOD-endpoint]]、[[IF-endpoint-sync]] |
| DSH 身份、写入屏障与归档怎样接入 | [[MOD-dsh-host]]、[[IF-host-writeback]] |
| 插件数据如何保存和恢复 | [[REQ-opaque-mapping]]、[[MOD-plugin-adapters]]、[[IF-plugin-data]] |
| Lynn 与 GPT compat 分别做什么 | [[REQ-lynn-gpt]]、[[MOD-plugin-adapters]] |
| DSH 插件入口与 Maintenance 看板 | [[MOD-ui]] |
| 此次地图检查了什么 | [[VER-map-rebuild]]；旧产品证据 [[VER-sync-20260922]]、[[VER-host-20260922]] |

## 当前代码的责任边界

| 层 | 责任与代码入口 |
| --- | --- |
| 规范核心 | `packages/canonical-session-engine` 处理逻辑会话、版本、派生、归档/删除；`packages/session-store` 保存 SQLite 元数据和对象；`packages/projection-lifecycle`、`packages/transaction-engine` 管投影、恢复和事务。 |
| 同步协调 | `apps/engine/src/endpoint-sync.ts` 管对齐阶段、epoch、策略修订及提交串行化；`endpoint-session-commands.ts` 处理逻辑变更。它们使用端点 ID 和规范 DTO。 |
| 宿主适配 | `packages/instance-integration-dsh` 与 `plugins/dsh-session-maintenance` 处理实例发现、身份、Home/Profile、DSH 读写、宿主独占屏障、归档刷新及回执。DSH 格式编解码在 `packages/adapter-dsh-0-1-5` 等平台适配包。 |
| 插件适配 | `packages/adapter-lynn` 处理当前 Core / DAG / Sticker 组合的握手、映射与正常读取验证；`packages/extension-gpt-compat` 单独处理 GPT 事件与引用重映射；`apps/engine/src/adapters/lynn` 提供遗留业务 API 的适配装配。 |
| 呈现和接入 | `apps/dashboard` 调用 Engine API；DSH 插件提供工作区加入、变化上报和启动看板入口。界面不直接改写规范存储。 |

关键交接：实例加入维护并被选入同步范围 → Engine 对齐规范版本到该端点 → 宿主适配器取得目标会话写入权、恢复文件/归档/插件数据并核对回执 → 端点进入 active → 实例变化携带 epoch 回传并生成规范版本。对齐 blocked 时只允许新会话的插入式 discover，已有会话变更不冒充完成。缺少插件或未知结构化数据保留在真源，阅读时折叠，不能误投放到目标插件。

[当前责任与适配边界图源](diagrams/architecture.json) 随同一地图维护；图示为源码责任关系，不表示运行验收通过。

## 当前边界和待办

`apps/engine/src/composition-root.ts` 仍直接 import DSH、Launcher 发现、Lynn 与 GPT 的具体实现，并在这里装配它们。规范包和同步协调路径已经使用通用合同，但“Maintenance 整体不耦合宿主或插件”的全局要求尚不能标为完成。详情见 [[ISS-remaining-coupling]]。

源码包清单当前声明 Engine `0.1.43-rc2.95`、Dashboard `0.1.20`、DSH 接入插件 `0.2.27-rc2.79`。这些是源码版本，不证明某台实例正在运行该组合。Codex 工作区原生写回在 `WorkspaceSyncPolicyService` 中仍标为不支持；不要与 DSH 工作区双向同步混为一项能力。

## 旧地图定位

本次删除了旧 `docs/project` 的冗余记录、旧图源、导出与历史索引，保留相同项目 ID。历史资料可在 Git 修订 `d3fdbe3:docs/project/` 查回；常用旧 ID 见[旧地图记录定位](legacy-id-index.md)。旧文档中的 `[[旧记录 ID]]` 仅供历史定位，不代表本地图仍有该记录。原规格和变更报告保留在 `docs/superpowers`、`docs/changes`、`docs/reports`，其当时的版本和验收边界不因地图重建而改变。
