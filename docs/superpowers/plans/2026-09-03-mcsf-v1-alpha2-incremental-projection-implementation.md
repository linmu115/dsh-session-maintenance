# MCSF v1 与 Alpha2 启动差量投影实施计划

> 日期：2026-09-03
>
> 状态：已完成
>
> 目标分支：`codex/canonical-session-projection`
>
> 规格：`../specs/2026-09-03-maintenance-canonical-session-format-v1.md`

## 1. 当前基线

以下能力已经存在，不重复施工：

- Maintenance Canonical Session Format v1 基础事件契约；
- `other` 的 `log-only` 安全策略和 Alpha2 `maintenance/other` 投影；
- Alpha2 工具调用配对、WAL durable receipt、Codex 只读导入和延迟派生；
- 工作区、项目、墓碑、Checkpoint、运行租约和静态 WebUI；
- 最近 200 个会话热加载、其余会话按需读取。

本计划只补齐新规格与现有运行实现之间的缺口。它不重新实现旧计划，也不把历史兼容逻辑叠加成第二套运行主线。

## 2. 已确认约束

- 只实现 `dsh-alpha2` 格式族；不新增 RC2 或第三方 Harness Adapter。
- Maintenance 中只有一份 MCSF 会话正文；Codex/DSH ID 只是原生引用。
- Codex 真源保持只读，任何测试都不得写真实 Codex Home。
- 本地 Alpha2 投影是可重建派生物，不是真源，但正常停止后保留。
- 每次启动必须向 Maintenance 查询上次 Revision 之后的变化；没有变化的会话文件不得读取或改写。
- 运行期间 DSH 追加仍使用既有 WAL 和 durable receipt 主链。
- 不改 Launcher 生命周期，不构建 Generation，不执行真实数据迁移。
- 继续采用高价值断点；某一断点失败后才在相邻区间增加更细日志。

## 3. 任务顺序

### M00：MCSF v1 `other` 安全契约（已完成）

提交：`d56a63b feat: introduce MCSF v1 other-event contract`

断点：

- `canonical.normalize`
- `adapter.materialize`
- `projection.surface-audit`
- `client.card`
- `model-history.audit`
- `legacy.read`

### M01：建立 Canonical Change Journal

状态：已完成。提交：`ae8331a feat: add canonical change journal`。

目标：为启动差量查询提供稳定、单调递增的 Maintenance Revision，不扫描会话正文。

实现：

- 增加 `CanonicalChange`、`CanonicalChangePage` 和 `CanonicalChangeQuery` 共享契约；
- 新增 `canonical_change_log`，为已有 MCSF 会话建立一次轻量基线；
- 对会话正文头、元数据、工作区、项目、派生和墓碑变化写入变更记录；
- `CanonicalSessionRepository.listChanges()` 按 Revision 分页；
- 同一页只返回轻量 ID、变化类型和时间，不返回正文。

断点：`canonical.change-journal`。入口证据是 `currentRevision`、`throughRevision`、返回条数和受影响会话数，不记录正文。

验证：契约测试、迁移测试、Repository 分页与幂等测试。

### M02：建立 Adapter Evidence Port

状态：已完成。提交：`2092d8d feat: isolate adapter evidence`。

目标：把 Harness 原始证据从 MCSF 公共事件中解耦。

实现：

- Adapter 只能通过 `putEvidence/readEvidence` 保存和读取内容寻址证据；
- `other.evidenceRef` 指向证据对象，不内嵌原始 payload；
- Codex 导入器和 Alpha2 Adapter 仅保存各自来源证据；
- 读取失败只影响诊断展开，不得扩大为模型可见内容。

落地说明：当前只接入 Codex Read 与 DSH Alpha2 两条新未知事件入口；RC2 和历史 `rawPayload` 不在本阶段迁移范围内。

断点：`adapter.evidence`。只记录 Adapter、摘要和结果。

### M03：统一 Native Session Reference 读模型

状态：已完成。提交：`c3b2f3d feat: unify native session references`。

目标：把 source、active projection 和 historical alias 作为一张身份索引展示，不复制会话正文。

实现：

- 共享 DTO 与只读查询接口；
- 聚合现有 binding、projection mapping 和 alias；
- WebUI 与 Adapter SDK 只消费统一读模型；
- 不在本任务中合并物理表，不改 Codex 真源。

落地说明：Schema v14 只扩展状态断点；引用数据继续由现有三张生命周期表
分别拥有，统一 Repository 仅在读取时组合。Maintenance 会话详情页与稳定链接
解析共用该索引，Adapter SDK 导出同一 DTO 与只读接口。

断点：`reference.index`。验证一个逻辑会话可以解析来源、当前投影和历史链接。

### M04：建立持久 Alpha2 投影缓存

状态：已完成。提交：`f29efcd feat: add persistent projection cache`。

目标：一个不兼容原生格式族对应一个独立、长期保留的可重建投影空间。

实现：

- 缓存身份由 Adapter 格式族和投影配置决定，不由单次 runId 决定；
- Manifest 保存 `lastAppliedRevision`、Adapter 指纹和每会话摘要；
- 首次启动建立完整基线；
- 后续启动调用 `listChanges(after=lastAppliedRevision)`，按受影响会话去重；
- 新增/正文/元数据/工作区/项目/派生/墓碑分别应用最小必要变化；
- 未变化会话文件不读取、不改写。

落地说明：缓存目录由 Adapter 格式族 ID 与投影配置摘要唯一确定，runId
不参与身份；Adapter manifest 指纹变化时在同级 staging 目录完整重建并原子
替换。缓存 Manifest 除每会话 native digest 外只保存运行恢复所需的轻量元数据
和 native revision，不保存消息、工具调用或附件正文。Schema v15 为工作区定义、
项目定义及项目根变化补齐变更日志触发器。

断点：`projection.delta-apply`。记录起止 Revision、变化 ID 数、实际改写数、删除数和未改动数。

### M05：把运行生命周期切到持久缓存

状态：已完成（本任务提交：`feat: retain Alpha2 projection cache`）。

目标：保留现有实时 WAL 回写，正常停止不再删除已验证的 Alpha2 投影。

实现：

- run lease 与 WAL 仍然按运行隔离；
- DSH 通过每次运行的稀疏可写覆盖层读取已完成差量更新的只读基础缓存；
- durable receipt 先推进 Canonical；停止或恢复时再按 Change Journal 刷新基础缓存；
- 正常停止 flush、校验、Checkpoint、释放租约并保留缓存；
- 异常停止保留待恢复状态，恢复完成后再更新缓存 Revision；
- 不允许未确认 WAL 被下次启动的 Canonical 差量覆盖。

落地说明：基础缓存不在运行中接收 DSH 写入，避免 Codex 来源会话首次续写时
覆盖原始分支。所有运行期新增和修改只进入 run-local overlay 与 WAL；关闭或恢复
必须先取得 Maintenance durable receipt，再刷新基础缓存，最后只清理 overlay。
无变化重启连基础目录 sidecar 也不改写。

断点：沿用 P1-P5、P8，并增加 `projection.cache-retained` 终点。

### M06：最小 Alpha2 验收

状态：已完成（本任务提交：`test: accept MCSF Alpha2 projection`）。

只检查：

1. 首次基线；
2. 无变化重启时零正文改写；
3. 一个会话追加后只改一个会话；
4. 项目或工作区变化只影响目标；
5. 墓碑会话不再出现在投影；
6. `other` 不进入模型上下文；
7. 正常停止后缓存仍在；
8. Codex fixture 摘要在测试前后不变。

验收结果：5 个聚焦文件、13 项测试全部通过。项目/工作区目标化更新使用
真实 Schema v16 Change Journal 与 SQLite Projection Source，确认只重写目标
会话和目标工作区；运行追加测试另有未涉及会话作为零改写对照。Codex 只读
边界通过合成 Home 的前后整树 SHA-256 摘要验证。

用户点击验收只在这些自动断点通过之后进行。本任务不构建 Generation，也不推送远端。

## 4. 每任务交付规则

每个任务必须包含：

- 一个先失败的聚焦测试；
- 最小实现；
- 一份 `docs/changes/SESSION-MAINT-MCSF-MNN.md`；
- 仅运行该任务和直接受影响的测试；
- 一个独立提交；
- 工作树恢复干净。

遇到真实数据数量不符、pending WAL 身份不明、Adapter 无法证明字段语义或 Codex 路径可能被写入时立即停止，不猜测、不扩大修改范围。
