# 会话主干图：后端、数据合同和域面板

日期：2026-09-15。需求基线：`e458ce4` 及 2026-09-14 修订的会话上下文图规格。本报告只覆盖本仓库的图域实现；Annotation 实际读取/交付钩子与 ThoughtDAG/Sticker 消费者由本轮其它任务联动完成。未在真实会话数据中测试，未部署运行副本。

## 实现

- `managedSchema: 2` 包含目标逻辑会话归属、未绑定占位节点、待绑定连接、关系移除记号和旧图迁移状态。`main-{目标身份摘要}` 在实例/profile 范围内唯一；重复引用和再次进入复用同一主干，不扫描全部历史自动生成图。
- `MaintenanceGraph` 协议升级到 2，提供 ensure/load/save/bind/remove、目标限定 relations、disclosures、sourceMarkers。创建工作区和真实会话继续使用 MaintenanceKnowledge 现有官方宿主路径。
- Engine 的 ensure/save/bind/remove HTTP 写操作使用现有写入协调器；布局保存不能偷偷移除仍有效的引用。统一 remove 在同一 SQLite savepoint 中撤销所选 Annotation 关系并更新图，失败整体回滚，成功后旧布局/重试无法恢复已撤销引用。移除主干卡片也保留图归属和真实会话身份。
- 固定源版本、截止事件、源回复、提交状态由 Engine 从 Annotation 权威对象补入边的展示元数据。存储不将这些展示字段当作独立上下文权限。
- 旧 schema 1 图加载时只生成迁移视图；关系端点核验且接收会话唯一时可确定主干。混合目标或不可核验来源保持待处理，原知识线进入只读 legacyEdges。保存迁移使用新对象，原图不删除；绑定时已有主干会返回 reused 和保留的草稿身份。
- Adapter 同时识别 schema 1/2，登记 ThoughtDAG `0.4.14-rc2.6`、Sticker `0.7.3-rc2.14`、Annotation `0.3.12-rc2.8`。schema 2 的泛型扩展写入口拒绝绕过图领域操作。
- Sticker source.locator 保存稳定消息 ID、选文和 occurrence；创建写入核验其来源回复与权威引用。sourceMarkers 按当前实例可见源会话分页，只返回 pending/sent 关系；撤销后立即停止返回相应蓝色入口数据。
- Dashboard 移除全局网络组件及入口，图域面板保留结构、固定上限、撤销数量、迁移信息、冲突检查和位置记录预览。受管理的图/日志不能在泛型 JSON 编辑器中直接删除或覆写。
- 删除专属全局 network/impact 的 DTO、Engine 服务、路由与 API client 方法。共享贴纸、笔记、迁移、会话目录接口保留；旧综合回归调整为目标关系查询及按域分页检查。

## 轻量位置日志

`appendDisclosure` 仅接受身份、固定上限、实际片段位置、继续位置、字节计数和结果/交付状态，不接受正文、搜索词、提示词或工具结果全文。一次请求的 requestId 在引用/执行范围内去重；相同身份而范围发生变化会拒绝覆写。prepared 可以变成 returned/failed；returned 可以因宿主取消降为 failed，failed 不会复活为 returned。

每个主干的日志保存在 ThoughtDAG 域独立 `disclosures-{目标身份摘要}` 当前对象。默认上限为 256 条、262144 字节，可通过 `DSH_GRAPH_LOG_MAX_ENTRIES`（1–256）和 `DSH_GRAPH_LOG_MAX_BYTES`（8192–262144）调小。达到条数或字节上限会清理旧明细并保留 trimmed/trimmedCount；每页最多 20 条。不同位置保持各自范围，不将跳读间的空白区间标记已读。

disclosures 同时返回当前页的派生 coverage：仅合并已确认 returned、同引用/源版本/执行/事件中的重叠或相邻区间；prepared/failed 不构成已披露范围，也不跨空白合并。派生结果最多 128 组、64 KiB，超过时 coverageTruncated 明示裁剪。原始回执身份保留，合并不影响去重或存储修订。

SqliteExtensionRepository 只 UPSERT 当前 extension_objects 行，没有 extension_versions 或逐次日志快照。日志更新使用最新修订并同步提交，不积累布局冲突；图布局 revision 与日志 revision 分开。日志扩展引用只指向目标逻辑会话，不钉住来源版本。停用/未接入 ThoughtDAG 时 syncReference/append/settle 返回独立读取可继续的结果，既有数据保留，不补写停用期间的虚假记录。

## 验证

聚焦测试命令覆盖 7 个文件、18 项测试，全部通过：

```
pnpm exec vitest run apps/engine/test/session-main-graph.test.ts apps/engine/test/session-knowledge.test.ts apps/engine/test/managed-graph-schema.test.ts apps/engine/test/session-graph-service.test.ts apps/dashboard/test/main-graph-panel.test.tsx apps/dashboard/test/extension-page.test.tsx plugins/dsh-session-maintenance/test/session-graph.test.ts
```

覆盖重复主干、目标范围隔离、未绑定卡片、复用主干保留草稿、统一移除与重试、旧保存防复活、独立引用保留、图写失败原子回滚、混合旧图保护、日志交付/去重/条数/分页、日志无正文、当前对象数量恒定、无额外冲突、匹配版本/schema、宿主固定 run、来源标记撤销恢复和 Dashboard 无全局查询/泛型删除旁路。

contracts 和 local-api-client 构建通过；Engine、Dashboard、Maintenance 宿主类型检查通过；`git diff --check` 通过。所有数据库与原生会话测试使用内存 SQLite 或 createEngineFixture 标记临时目录；原生家目录树哈希保持不变。

## 组合验证范围

本提交不代替用户的副本交互验收。ThoughtDAG 的画布目录需要排除 disclosures 对象；读取位置展示必须区分 prepared/returned/failed。实际 AI 返回范围与宿主交付证据由本轮 Annotation/SessionContext 钩子提供，不能凭 UI 预览宣称模型已读取。旧对象仍需在用户明确进入并核验归属后迁移，不执行批量猜测迁移。

## 交叉审查后的迟到回执修复

交叉核对 Annotation `3b92984` 与本轮 SessionContext 钩子时，确认读取发生在 ThoughtDAG 停用期间、确认交付前重新启用时，原先的 settle 会因没有日志对象而报错；旧明细已裁剪时迟到确认也会永久失败。图服务现在返回明确的 `recorded:false` 和 `not-recorded-or-trimmed`／`extension-unavailable` 原因，不创建虚假回执，不阻止合法独立读取或初始引用绑定。已有回执身份不唯一、失败回执复活和真实存储写入错误仍然拒绝；记录存在且更新成功才返回 `recorded:true`。Context 服务负责透传此结果并继续拒绝已撤销引用的 returned 确认。

新增合成测试覆盖无日志对象、旧记录裁剪、合法确认、身份歧义和存储失败不被吞掉。图域与真实 SessionContext 回归共 10 项通过，Engine 类型检查通过。只读来源预览继续不生成 AI 已读回执；现有初始准备/已交付区分和单调收紧预算未发现本轮引入的倒退。
