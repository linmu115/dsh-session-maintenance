# Session Maintenance 稳定真源与 DSH 临时投影设计规格

- 日期：2026-08-31
- 状态：架构已逐节确认，待规格终审
- 目标项目：dsh-session-maintenance
- 目标运行环境：Windows、本地 Session Maintenance Engine、DSH Launcher Profiles、DSH 0.1.1-rc.2 与 0.1.2-alpha.2
- 设计范围：会话真源、逻辑工作区、Codex 增量导入、DSH 临时投影、公开适配器 SDK、独立 WebUI、迁移、恢复与渐进验收

## 1. 决策摘要

Session Maintenance 将成为所有 DSH 会话内容与逻辑工作区结构的唯一稳定真源。任何 Launcher Profile 或普通 DSH 实例都不再永久拥有自己的会话；实例启动时从 Maintenance 真源生成适合当前 DSH 版本的临时投影，运行期间只操作该投影，并把新增内容持续增量提交回 Maintenance。正常关闭后完成最终提交、校验和 Checkpoint，再清空临时投影。异常关闭时只保留待恢复投影和运行预写日志，恢复完成后清除。

Codex 保持独立真源。Maintenance 可以增量读取并保存 Codex 会话镜像，但不得修改、插入、重排或删除 Codex 原生会话内容。同一个 Codex 会话在没有被 DSH 追加时始终对应一个 Maintenance 逻辑会话；相同内容的重复扫描是空操作。只有 DSH 第一次真正续写该会话时，Maintenance 才从投影实际使用的 Codex 版本派生一个新的独立逻辑会话。派生会话继承工作区、标题与标签，解除 Codex binding，并保存来源会话和来源版本，不强制修改标题。

首版只允许一个活动 DSH 内容写入租约。数据模型保留 branchId、baseVersionId、parentVersionIds、runId、leaseId 和 mergeStatus 等扩展边界，以便未来让多个实例运行在各自分支并在 Maintenance 内合并，但首版不实现多写者和分支合并。

DSH 版本差异由公开 Adapter SDK 隔离。RC2、Alpha2 和未来版本使用各自适配器，把 Maintenance 稳定格式转换为当前 DSH 的原生格式。适配器接口、能力协商、开发文档、示例和一致性测试必须向其他开发者公开。兼容性以接口探测和能力为准，不以普通 semver peer dependency 硬锁实验组合。

Maintenance 管理界面采用独立本地 WebUI，不嵌入某一版 DSH 前端。它提供统一工作区树、静态会话查看、来源谱系、删除与恢复、Checkpoint、活动运行、投影状态、适配器状态和诊断时间线。DSH 设置页和 Launcher 只提供打开入口。

关键功能验收采用渐进式状态断点。每个关键断点必须同时是稳定的状态日志入口，记录开始、成功或失败及其运行关联信息。只有关键断点失败时，才在相邻断点之间增加更细的临时诊断日志；修复后保留一条针对真实故障的回归测试，不预先建设庞大而低效的组合测试矩阵。

## 2. 与旧设计的关系

本规格保留 2026-08-26 DSH–Codex 会话维护系统设计中的以下原则：

- Maintenance Engine 是独立业务核心；
- 会话版本不可变；
- 平台读取、写入和恢复通过适配器隔离；
- Codex 原生内容不得被未经授权改写；
- 所有真实数据变更必须可追溯、可验证和可恢复；
- Dashboard、DSH 插件和自动化入口调用同一引擎。

本规格取代旧设计中的以下部分：

- Codex 与 DSH 平台会话长期绑定在同一个 logical session；
- native_mirrors 同时维护两个可写平台头；
- 以 source-ahead、target-ahead 和 diverged 作为长期双向镜像主模型；
- DSH Profile Home 永久保存自身会话副本；
- DSH 原生 workspace ID 或 binding 决定逻辑工作区归属；
- 通过精确版本 peer dependency 阻止未验证组合。

2026-08-27 RC2 Core Extension 规格继续作为旧 RC2 写入和恢复机制的历史依据，但新架构只通过公开 Adapter SDK 调用版本专属能力。任何 RC2 内部 hook 不得泄漏到 Maintenance Engine 或规范会话模型。

旧规格保留在仓库中，不被覆盖或删除。本规格在冲突范围内优先。

## 3. 问题背景

DSH Launcher 为不同版本和 Profile 使用独立 Home。每个 Home 都有自己的会话目录、工作区登记和原生 ID 命名空间，因此切换实例会表现为工作区和会话全部消失或散落。直接把多个 Home 的 sessions 目录链接到同一物理目录虽然简单，却把不同 DSH 版本的破坏性格式变更直接施加到同一真源，并且存在进程异常、缓存、索引和并发写入风险。

当前 native_mirrors 模型把 Codex 与 DSH binding 放在同一个逻辑会话内，并试图判断两端头部关系。它无法表达本次确认的延迟分裂语义：

- Codex 原会话在 Maintenance 中持续增量更新；
- 仅在 DSH 中阅读不创建新分支；
- 第一次 DSH 续写才创建独立派生会话；
- 派生后 Codex 与 DSH 各自沿独立会话继续；
- 工作区结构独立于任何 DSH 版本。

同时，DSH 0.1.2 系列已经删除或改变多项旧 Runtime、Session 和 UI 接口。未来版本仍可能继续发生破坏性变更，因此 Maintenance 真源不能使用某一版 DSH 的事件对象、目录布局、workspace schema 或 session ID 作为稳定格式。

## 4. 目标

### 4.1 核心目标

1. Maintenance 独立保存所有 DSH 会话内容和逻辑工作区结构。
2. 任意受支持的 Launcher Profile 在启动时看到同一套工作区与会话。
3. DSH 实例关闭后不永久持有会话。
4. DSH 版本更新只需要新增或修改版本适配器。
5. Codex 保持自己的独立真源和现有读取逻辑。
6. Codex 增量导入在内容相同时不创建版本或副本。
7. DSH 第一次续写 Codex 会话时延迟创建派生会话。
8. Annotation、Sticker、Obsidian 引用和历史深链接可跨投影继续定位。
9. 会话只能在 Maintenance WebUI 中执行全局删除，并支持恢复。
10. 正常关闭、异常退出和部分提交均不会静默丢失内容。
11. Adapter SDK 可供第三方开发者实现未来 DSH 版本适配。
12. WebUI 和状态日志能够精确显示故障所处的运行阶段。

### 4.2 可演进目标

- 保留未来多实例分支运行和两父合并的数据边界。
- 允许用户在未验证 DSH 版本上强制试运行兼容适配器。
- 允许第三方适配器通过 npm、本地目录、Git 构建产物或 Generation 登记。
- 允许未来在不改变真源模型的前提下加入缓存和按需投影优化。

## 5. 非目标

- 首版不允许两个 DSH 实例同时写入同一主分支。
- 首版不实现自动会话分支合并。
- 不把 Maintenance 变成 Codex 原生写入器。
- 不修改、重排或删除 Codex 原生 rollout。
- 不把 Maintenance 数据库直接暴露为 DSH sessionPersistence。
- 不把某一版 DSH 原生 JSONL、Zstd、SQLite 或 workspace schema 作为真源格式。
- 不让 DSH 端删除直接传播成 Maintenance 全局删除。
- 不在首轮建立覆盖所有版本、插件和交互组合的大型测试矩阵。
- 不把用户会话内容打进 Maintenance Generation。
- 不承诺第三方 Node 适配器具备完整操作系统级安全沙箱。

## 6. 术语

- 稳定真源：Maintenance 保存的 DSH 逻辑会话、规范事件、版本和逻辑工作区。
- Codex 真源：Codex 自己维护的原生任务和 rollout。
- Codex 镜像：Maintenance 对 Codex 原生会话的只读增量副本。
- 逻辑会话：与平台会话 ID 和 DSH 版本无关的稳定会话身份。
- 规范事件：Maintenance 能跨 DSH 版本解释、保存和投影的稳定事件。
- 临时投影：本次 DSH 运行专用的原生会话与工作区空间。
- 投影映射：runId 下逻辑会话 ID 与当前 DSH 原生会话 ID 的临时关系。
- 历史别名：旧 DSH session ID、旧 workspace ID 或旧深链接到逻辑身份的长期解析记录。
- 适配器：把规范格式与特定 DSH 版本原生接口和格式互相转换的扩展。
- 运行预写日志：记录已被本次运行接受、但可能尚未写入 Maintenance 真源的幂等操作。
- 租约：允许一个 DSH 运行写入 Maintenance 主分支的临时权利。
- 派生会话：第一次从 Codex 镜像在 DSH 续写时创建的 Maintenance 独立会话。
- Checkpoint：可追溯的 Maintenance 数据、版本头、工作区和运行状态恢复点。
- 状态断点：关键功能阶段的稳定日志入口，而不是强制暂停进程的调试器断点。

## 7. 系统不变量

1. Maintenance 是所有 DSH 会话和逻辑工作区的唯一稳定真源。
2. Codex 原生任务始终由 Codex 自己拥有。
3. Maintenance 不向 Codex 原生会话写入任何内容。
4. DSH Profile Home 不保存跨运行永久会话。
5. 规范版本不可变；内容变化产生新版本。
6. 相同 Codex 内容重复观察不创建版本。
7. 仅投影和阅读 Codex 会话不创建派生会话。
8. 第一次 DSH 持久追加最多创建一个派生会话。
9. 派生会话始终记录来源逻辑会话和来源版本。
10. 派生会话不保留 Codex authority binding。
11. DSH 原生 ID 不是逻辑会话身份。
12. 未知事件不得被静默丢弃。
13. 一个已确认 operationId 不得产生第二次追加或第二个派生会话。
14. 未确认写入存在时不得删除其恢复材料。
15. DSH 端删除不得写入全局删除墓碑。
16. Maintenance 删除必须先建立删除前 Checkpoint。
17. 首版同一时刻最多存在一个 DSH 内容写入租约。
18. 适配器不得直接访问 Maintenance 数据库。
19. 普通 DSH semver 不匹配不得成为安装或试运行硬锁。
20. 每个关键状态断点必须有可查询的状态日志事件。

## 8. 方案比较与选型

### 8.1 方案 A：受控临时投影与官方 Persistence 适配器

Maintenance 在启动时生成当前 DSH 版本认识的临时投影，版本适配器接入官方 sessionPersistence，运行期间通过预写日志把新增事件提交回 Maintenance，退出时清理投影。

优点：

- 完全符合实例非运行时不持有会话的要求；
- Maintenance 真源与 DSH 破坏性格式变更隔离；
- RC2 与 Alpha2 都已经确认存在可替换的持久化 seam；
- 延迟分裂、异常恢复、深链接映射和工作区转换都有明确事务边界。

成本：

- 需要新的 Projection Lifecycle 深模块；
- 需要版本专属 Runtime Bridge；
- 需要对当前 native mirror 路径做结构迁移。

### 8.2 方案 B：Launcher 启停脚本搬运原生文件

Launcher 启动前把 Maintenance 内容转换并复制到临时 Home，运行期间监视原生文件，关闭后再导回。

优点是首期代码少；缺点是依赖 DSH 文件布局和文件监控时序，无法可靠识别第一次持久追加、部分写入和缓存状态。该方案不选。

### 8.3 方案 C：DSH 直接读写 Maintenance 数据库

直接把 sessionPersistence 实现为 Maintenance 数据库调用。

它省去投影目录，但让 DSH 运行时直接依赖真源服务，违背启动物化、退出清理和版本隔离要求。该方案不选。

### 8.4 选择

选择方案 A。所有后续数据模型、适配器、WebUI、迁移和验收均以此为前提。

## 9. 总体架构

    Launcher 或普通启动脚本
                |
                v
    Session Maintenance DSH Plugin
                |
                v
    Projection Lifecycle Service
       |        |         |
       |        |         +-- Adapter Registry / Adapter Host
       |        +------------ Run Lease / WAL / Recovery
       +--------------------- Canonical Session Engine
                                  |
                                  +-- Stable Session Store
                                  +-- Logical Workspace Store
                                  +-- Codex Import Service
                                  +-- Checkpoint Store
                                  +-- Dashboard API
                                           |
                                           v
                                Standalone Maintenance WebUI

核心模块采用深边界：

- CanonicalSessionService 管理逻辑会话、规范事件、版本头和派生关系。
- LogicalWorkspaceService 管理与平台无关的工作区树和会话归属。
- CodexImportService 只读取 Codex，并执行幂等增量导入。
- ProjectionLifecycleService 管理租约、投影、预写日志、关闭和恢复。
- AdapterRegistry 根据接口探测、能力和用户选择装载版本适配器。
- CheckpointService 管理删除前、启动前、关闭后、恢复后和升级前恢复点。
- DashboardApi 向独立 WebUI 暴露统一只读和管理操作。

Launcher 只是启动协调器，不是会话真源。DSH 插件即使由其他启动方式加载，也必须执行相同的 Projection Lifecycle。

## 10. 稳定数据模型

当前数据库 schema v6 的 logical_sessions、session_versions、version_parents、platform_bindings、platform_refs、native_mirrors 和 binding_workspaces 不被原地破坏。下一迁移系列从新数据库副本开始，并保留旧库只读。

### 10.1 logical_sessions

logical_sessions 增加或明确以下稳定属性：

- authority_scope：codex 或 maintenance；
- origin_kind：codex_mirror、maintenance_native 或 codex_derived；
- head_version_id；
- title；
- tags；
- archived_at；
- tombstoned_at；
- created_at；
- updated_at。

语义：

- codex_mirror 的内容权威在 Codex；
- maintenance_native 的内容权威在 Maintenance；
- codex_derived 的内容权威在 Maintenance，但保存 Codex 来源谱系。

### 10.2 session_versions 与 version_parents

session_versions 继续保存不可变版本。正常推进的 version_parents 保持在同一个 logical_session 内。

版本至少保存：

- logical_session_id；
- parent version 引用；
-规范事件清单摘要；
- 规范元数据摘要；
- 来源域；
- 来源游标；
- 创建时间；
-提交事务 ID。

同一逻辑会话内的普通版本推进使用 version_parents。不同逻辑会话之间的派生不伪装成同一会话内的父版本。

### 10.3 session_derivations

新增 session_derivations：

- child_session_id；
- parent_session_id；
- base_version_id；
- derivation_kind；
- trigger_run_id；
- trigger_operation_id；
- created_at。

首版 derivation_kind 至少支持 dsh_continuation。

它表示：

    Codex logical session
        |
        +-- base Codex version
                |
                +-- DSH-derived logical session

派生关系与会话内部版本图分层，避免现有每会话图查询被跨会话父边破坏。未来合并可以通过独立 merge record 和两父版本扩展，不在首版实现。

### 10.4 canonical_events 与内容对象

Maintenance 保存规范事件，而不是直接保存某一版 DSH 的事件对象。

CanonicalEventV1 至少包含：

- event_id；
- logical role 或 event kind；
- 规范化内容；
- source platform；
- source event ID；
- source sequence 或 cursor；
- content digest；
- occurred_at；
- raw payload reference；
- extension payload references。

稳定事件类型至少覆盖：

- 用户消息；
- 助手消息；
- 推理或过程节点；
- 工具调用；
- 工具结果；
- Annotation Core 注释；
- Sticker Board 贴纸；
- Obsidian 引用关系；
- 附件；
- 系统元数据；
- opaque unknown event。

未知事件必须保留原始载荷和来源。当前适配器无法等价投影时，在 WebUI 和兼容性报告中标记 held-out，不得静默删除。

事件内容对象采用不可变引用和摘要。派生会话首版可以复用来源版本的不可变内容对象，再追加自身事件，因此删除或继续更新来源会话不会改变派生会话视图。

### 10.5 平台绑定、投影映射与历史别名

三类关系必须分开：

1. Authority binding：Codex thread ID 到 codex_mirror logical session。
2. Projection mapping：runId 下 logical session ID 到当前 DSH native session ID。
3. Historical alias：旧 DSH session ID、workspace ID 或旧深链接到 logical session ID。

DSH 投影映射只在活动运行和恢复期存在，不代表内容所有权。

新生成的跨应用引用优先携带 logicalSessionId。旧引用仍可携带 sessionId，Maintenance 通过历史别名解析到逻辑会话，再映射到当前活动投影。这样 Obsidian、Annotation 和 Sticker 深链接不会因切换 DSH 版本失效。

### 10.6 逻辑工作区

新增或正式化：

- logical_workspaces；
- workspace_memberships。

logical_workspaces 保存：

- workspace ID；
- parent workspace ID；
- name；
- sort key；
- deleted state；
- created_at 和 updated_at。

workspace_memberships 保存：

- logical session ID；
- logical workspace ID；
- display order；
- pinned；
- archived；
- membership revision。

原生 DSH workspace ID 只存在于运行投影映射和历史迁移记录中。

### 10.7 运行、投影和预写日志

新增：

- projection_runs；
- projection_sessions；
- projection_workspaces；
- run_operations；
- run_status_events。

projection_runs 保存 runId、leaseId、instanceId、profileId、DSH version、adapterId、状态、心跳和 Checkpoint。

projection_sessions 保存：

- runId；
- nativeSessionId；
- logicalSessionId；
- baseVersionId；
- mode；
- current native revision；
- last committed operation；
- derived child session ID；
- projection state。

模式至少包括：

- maintenance-write；
- codex-read-until-write；
- hidden；
- recovery-only。

run_operations 是幂等预写操作记录，不是第三真源。操作提交后保留 receipt；运行关闭并建立 Checkpoint 后可按保留策略压缩。

### 10.8 删除墓碑

删除是 Maintenance 状态，不是物理文件删除。

墓碑至少记录：

- logical session ID；
- delete operation ID；
- 删除前 Checkpoint；
- 原工作区归属；
- 删除时间；
- 保留期限；
-恢复状态。

删除 Codex 镜像不会修改 Codex。后续 Codex 导入可以更新隐藏镜像，但不会自动解除墓碑。

## 11. Codex 增量导入与延迟分裂

### 11.1 Codex 同步

CodexImportService 保持现有只读逻辑：

1. 读取 Codex 原生会话。
2. 规范化内容并计算摘要。
3. 通过 Codex authority binding 找到 logical session。
4. 内容和元数据摘要相同时，只更新 observation 和 cursor。
5. 有新增内容时，在同一个 codex_mirror logical session 下创建新版本。
6. 不对 Codex 原生存储执行任何反向写入。

如果 source cursor 变化但规范化内容相同，只更新游标，不创建空版本。

### 11.2 仅投影不分裂

Codex 会话被物化到 DSH 时，projection_sessions.mode 为 codex-read-until-write。启动和关闭该投影而没有 DSH 持久追加时：

- 不创建新 logical session；
- 不创建新 version；
- 不创建永久 DSH binding；
- 不改变 Codex 镜像；
- 关闭时删除临时投影映射。

### 11.3 第一次 DSH 续写

第一次 DSH 持久追加由一个幂等事务完成：

1. 校验 operationId 未被处理。
2. 读取投影固定的 baseVersionId。
3. 创建 codex_derived logical session。
4. 写入 session_derivations。
5. 继承来源会话的逻辑工作区、标题和标签。
6. 不复制 Codex authority binding。
7. 将新 DSH 事件提交为派生会话版本。
8. 将当前 projection mapping 原子切换到派生会话。
9. 返回 commit receipt。

如果事务中途崩溃，恢复时通过 trigger_operation_id 找回同一个 child session，不重复创建。

如果 Codex 在运行期间已经产生更新，派生仍以投影实际使用的 baseVersionId 为基点。Codex 新版本继续进入原 codex_mirror，派生会话不自动追随。

### 11.4 DSH 新建会话

DSH 中创建的新会话在第一次持久内容出现时创建 maintenance_native logical session。空白或未发送的草稿默认不进入 Maintenance 真源。

## 12. Projection Lifecycle

### 12.1 运行状态机

    PREPARING
        |
        v
    RUNNING
        |
        v
    DRAINING
        |
        v
    VERIFYING
        |
        v
    CLOSED

异常分支：

    RUNNING
        |
        v
    RECOVERY_REQUIRED
        |
        v
    RECOVERING
       / \
      v   v
    RECOVERED  QUARANTINED

无法及时删除投影目录时进入 CLEANUP_PENDING。该目录已经不属于活动 DSH 实例，只是 Maintenance 管理的待清理恢复材料。

### 12.2 启动

启动顺序：

1. 识别 instanceId、profileId、DSH version、插件 Generation、进程 ID 和 runId。
2. 检查旧运行与恢复材料。
3. 完成必要恢复，或把无法自动处理的内容隔离。
4. 获取唯一 DSH 内容写入租约。
5. 选择并 probe 版本适配器。
6. 从 Maintenance 读取所有未删除逻辑会话和工作区。
7. 使用当前适配器生成完整临时投影。
8. 写入 ProjectionManifest。
9. 校验会话数量、工作区数量和内容摘要。
10. 适配器接入 DSH sessionPersistence。
11. 状态转为 RUNNING，允许 WebUI 加载会话。

首版采用启动时完整物化，不实现运行时按需直读 Maintenance。以后可以在不改变接口语义的前提下增加缓存。

### 12.3 运行写入

每次 DSH 原生追加：

1. 校验 native revision。
2. 分配或接受稳定 operationId。
3. 把操作持久写入本次运行 WAL。
4. 更新临时投影。
5. 通过适配器转换为规范事件。
6. 向 CanonicalSessionService 提交幂等事务。
7. 写入 commit receipt。
8. 更新投影 revision 和状态日志。

Maintenance 短暂不可用时，已经被 DSH 接受的写入保存在 WAL 和临时投影中，并显示待提交状态。后台重试。待提交数量超过安全阈值后暂停新的持久写入，但不影响读取。未完成提交时不得清除恢复材料。

### 12.4 运行期间删除

DSH 端删除只对当前投影隐藏，不创建全局墓碑。UI 必须提示永久删除需要进入 Maintenance WebUI。

Maintenance WebUI 删除活动会话时：

1. 对该 logical session 获取操作锁。
2. 提交已有待处理写入。
3. 建立删除前 Checkpoint。
4. 写入墓碑并解除工作区归属。
5. 通知活动投影隐藏并撤销对应会话。
6. 后续原生写入返回 SESSION_TOMBSTONED。

如果已有写入无法安全提交，会话立即从管理视图进入 pending-delete，但恢复材料不删除。状态日志必须明确显示等待哪项提交。

### 12.5 正常关闭

1. 转为 DRAINING，停止接受新写入。
2. 提交全部 WAL。
3. 确认待提交操作数为零。
4. 校验修改会话的版本头和摘要。
5. 校验工作区清单和新会话登记。
6. 建立运行结束 Checkpoint。
7. 标记运行已提交。
8. 停止 DSH 对投影的占用。
9. 删除临时投影。
10. 释放租约并转为 CLOSED。

目录被占用时转为 CLEANUP_PENDING，后台清理。租约只有在 DSH 已停止写入且恢复材料已归 Maintenance 管理后才能释放。

### 12.6 异常恢复

进程消失或心跳超时后：

1. 运行转为 RECOVERY_REQUIRED。
2. 保留投影、WAL、manifest 和状态日志。
3. 重放没有 receipt 的 operationId。
4. 已提交操作只补确认，不重复追加。
5. 已创建派生会话复用原 ID。
6. 校验 Maintenance 头版本和投影 revision。
7. 建立恢复 Checkpoint。
8. 删除旧投影并转为 RECOVERED。

无法解析的事件进入 QUARANTINED。新的 DSH 写入租约在恢复完成或用户通过 Maintenance 明确隔离问题前不发放。历史读取和 WebUI 静态查看仍可用。

## 13. Launcher Profile 接入

每个 Launcher Profile 只保存运行配置：

- DSH 版本；
- 插件 Generation；
- 模型与端口；
- Maintenance endpoint；
- adapterSelection；
- 可选 pinnedAdapterId。

建议配置：

    sessionSource: maintenance
    maintenanceEndpoint: auto
    adapterSelection: auto
    pinnedAdapterId: null
    generationId: selected-generation

Profile Home 不保存跨运行会话。Session Maintenance 数据目录独立于：

- Launcher 版本目录；
- Profile Home；
- DSH 安装目录；
- Codex Home；
- 临时投影目录。

Launcher 启动时可预先唤醒 Engine，但 Projection Lifecycle 由 DSH 插件执行。绕过 Launcher 启动时仍使用相同语义。

首版租约阻止意外双开。未来多实例扩展使用各自 branchId 和 baseVersionId，不共享写入头；合并只能在 Maintenance 中执行。

## 14. 独立 Maintenance WebUI

### 14.1 部署

Dashboard 由 Maintenance Engine 提供本地 API 和独立 WebUI。它只绑定 loopback，端口可配置，并通过 Maintenance 状态文件供 Launcher 和 DSH 插件发现。

入口：

- Launcher 的会话维护按钮；
- DSH 设置页的打开 Session Maintenance 按钮；
- 本地启动脚本；
- 固定本地 Web 地址。

DSH 关闭或升级不影响 Dashboard。

### 14.2 主界面

主界面采用两栏布局：

- 左侧统一逻辑工作区和会话树；
- 右侧静态会话查看与管理。

左侧显示：

- 工作区层级；
- 会话标题；
- Codex、DSH 派生和 DSH 原生来源；
- 固定、归档、标签和删除状态；
- 待提交、待恢复和隔离状态；
- 搜索与来源筛选。

右侧读取 Maintenance 真源，显示：

- 用户与助手消息；
- 工具调用和结果；
- Annotation；
- Sticker；
- Obsidian 引用；
- 附件与系统事件；
- 版本和来源；
- 无法识别事件的安全占位；
- 可选原始载荷视图。

静态查看器不执行工具、模型请求、原始 HTML 或历史脚本。

### 14.3 管理能力

WebUI 提供：

- 新建、重命名、移动和排序逻辑工作区；
- 移动会话；
- 修改标题和标签；
- 固定、归档和恢复；
- 删除、最近删除和恢复；
- 创建、预览和恢复 Checkpoint；
- 查看 Codex 与 DSH 派生谱系；
- 查看活动运行、租约、投影和适配器；
- 查看待提交操作和恢复材料。

删除工作区不会删除其中会话。会话先移动到未归类。

Checkpoint 恢复创建新的可追踪状态，不改写旧历史。

### 14.4 来源谱系

    Codex session
      +-- C1
      +-- C2  <- derivation base
      |     +-- DSH-derived session
      |           +-- D1
      |           +-- D2
      +-- C3

页面提供来源与派生会话双向跳转，并显示分裂基点、触发 runId 和活动投影。标题相同时依靠来源标识区分，不强制加后缀。

### 14.5 浏览器自动验收

WebUI 使用稳定路由、普通 HTML 操作、明确可访问名称和固定测试标识。核心流程不依赖右键菜单或操作系统原生弹窗。状态变化必须在页面内可见。

浏览器控制可以：

- 查看 Profile、DSH 版本和适配器；
- 检查工作区树；
- 查看派生关系；
- 查看状态断点；
-执行删除、恢复和 Checkpoint；
- 对照 DSH 页面完成端到端验收。

涉及交互体验的最终判断仍由用户亲自验收。

## 15. 公开 Adapter SDK

### 15.1 包结构

遵循当前仓库 @linmu 命名：

- @linmu/dsh-session-adapter-sdk；
- @linmu/dsh-session-adapter-dsh-rc2；
- @linmu/dsh-session-adapter-dsh-alpha2。

现有 @linmu/dsh-adapter-dsh 可以在迁移期作为内部来源，但新适配器必须通过公开 SDK 实现。

### 15.2 职责

适配器负责：

- probe DSH 版本和能力；
- 规范格式与原生投影互转；
- 接入当前版本 sessionPersistence；
- revision 校验；
- 原生追加规范化；
- 投影 inspect 和 verify；
- 原生 ID、锚点和深链接解析；
- 未知事件保留；
- 错误解释和诊断。

适配器不得：

- 决定 Codex 分裂；
- 创建或删除 logical session；
- 修改逻辑工作区；
- 管理租约或 Checkpoint；
- 访问 Maintenance 数据库；
- 直接写真实 Codex 或永久 DSH Home。

### 15.3 双入口

每个适配器包含：

1. Engine Codec：物化、规范化、检查和验证。
2. Runtime Bridge：接入当前 DSH sessionPersistence，操作临时投影、WAL 和提交端口。

公开主接口：

    interface DshSessionAdapterV1 {
      manifest: AdapterManifestV1
      probe(environment): Promise<AdapterProbeResult>
      materialize(input, output): Promise<ProjectionManifest>
      normalizeAppend(operation): Promise<CanonicalAppendOperation>
      inspect(projection): Promise<ProjectionInspection>
      verify(expected, actual): Promise<VerificationResult>
      resolveReference(reference, projection): Promise<NativeReferenceResolution>
    }

运行桥：

    interface DshRuntimeBridgeV1 {
      attach(context): Promise<RuntimeHandle>
      drain(handle): Promise<DrainResult>
      detach(handle): Promise<void>
    }

RuntimeAttachContext 只暴露 runId、投影目录、受控 WAL 端口、映射查询、Maintenance 提交和诊断端口。

### 15.4 Manifest 与能力

AdapterManifestV1 包含：

- id；
- displayName；
- adapterApiVersion；
- packageVersion；
- testedDshVersions；
- declaredDshRange；
- capabilities。

能力至少声明：

- sessionPersistence contract；
- append 和 revision；
- readFrom；
- borrowSession；
- Snapshot；
- 工作区投影；
- Annotation；
- Sticker 和 Obsidian reference；
- unknown event round trip；
- stable native IDs；
- metadata hot update；
- deep-link resolution；
- recovery；
- projection verification。

### 15.5 兼容性与实验模式

testedDshVersions 是验证记录，不是安装硬锁。

选择顺序：

1. Profile 固定适配器；
2. 当前 DSH 已验证适配器；
3. probe 能力兼容适配器；
4. 用户选择的实验适配器。

未登记 DSH 版本可以 experimental 模式运行，并记录在 run manifest 与 Checkpoint。普通 semver 或 optional capability 缺失不禁用试验。只有 Engine 完全无法理解 adapterApiVersion 主版本时不能直接调用，因为双方不存在可解释函数协议；仍可在 Adapter Host 中运行隔离探测并查看报告。

### 15.6 第三方加载

WebUI 可登记：

- npm 包；
- 本地目录；
-本地打包文件；
- Git 构建产物；
- Generation 内适配器。

适配器在独立 Adapter Host 子进程中通过 typed RPC 运行。崩溃、超时和日志与 Engine 隔离，但第三方 Node 代码仍视为本机受信代码。

### 15.7 SDK 文档

必须发布：

    docs/adapters/
      README.md
      architecture.md
      contract.md
      capabilities.md
      version-negotiation.md
      authoring-guide.md
      testing-guide.md
      publishing-guide.md
      compatibility-matrix.md
      migration-guides/
      examples/minimal-adapter/

每个内置适配器必须维护：

- CHANGELOG.md；
- BREAKING-CHANGES.md；
- COMPATIBILITY.md。

BREAKING-CHANGES 必须逐条记录 DSH 破坏性接口、原错误表现、适配方法、数据降级和对 Annotation、Sticker、Obsidian 引用的影响。

## 16. 状态日志与渐进诊断

### 16.1 状态日志入口

每个关键功能断点必须是稳定的状态日志入口。状态日志不仅记录错误，也记录阶段进入和成功，因此能够确定故障发生在两个已知边界之间。

StatusEventV1 至少包含：

- eventId；
- timestamp；
- runId；
- leaseId；
- profileId；
- adapterId；
- DSH version；
- stage；
- state：started、succeeded 或 failed；
- logicalSessionId；
- nativeSessionId；
- operationId；
- parentEventId 或 spanId；
- errorCode；
- durationMs；
- diagnosticDetailRef。

日志不得默认保存完整会话文本、模型密钥或鉴权 token。详细错误写入受控诊断对象，通过 diagnosticDetailRef 引用。

### 16.2 固定关键断点

| 断点 | 稳定 stage 名 | 目的 |
|---|---|---|
| P1 | run.lease | 获取与释放唯一写入租约 |
| P2 | projection.materialize | 读取真源并生成完整投影 |
| P3 | runtime.persistence.attach | DSH 成功接管 sessionPersistence |
| P4 | session.append.commit | WAL、规范化、提交与 revision 推进 |
| P5 | session.derivation.create | Codex 延迟分裂只创建一个派生会话 |
| P6 | projection.cross-version.verify | 不同 DSH 版本看到同一逻辑结构 |
| P7 | reference.roundtrip.verify | Annotation、Sticker、Obsidian 引用可保存和定位 |
| P8 | run.shutdown-recovery | 正常清理与异常恢复 |

每个 stage 至少产生 started 和 succeeded 或 failed。

示例：

    stage=session.append.commit state=started operationId=op-123
    stage=session.append.commit state=succeeded operationId=op-123

### 16.3 失败区间细分

如果 P4 失败，且日志显示：

    WAL durable
        |
        X
        |
    canonical commit confirmed

只在该区间增加临时子阶段：

- append.normalize；
- transaction.open；
- events.insert；
- head.update；
- receipt.write。

这些子阶段使用 parentEventId 或同一 spanId 与 P4 关联。定位并修复后：

- 保留 P4 稳定入口；
- 删除没有长期诊断价值的高噪声临时日志；
-保留必要错误码；
- 添加一条精确回归测试。

### 16.4 WebUI 与 API

运行中心提供：

- 按 runId 查看时间线；
- 按 logicalSessionId 或 operationId 筛选；
- 查看当前卡住的阶段；
- 展开 diagnosticDetailRef；
- 导出脱敏诊断包；
- 观察实时状态事件流。

本地管理 API 提供状态事件查询和 SSE 或等价实时流，供 WebUI 和浏览器控制使用。

## 17. 旧数据迁移

### 17.1 迁移流程

1. 停止 DSH 写入并检查租约。
2. 建立迁移前 Checkpoint。
3. 复制并封存旧数据库。
4. 在新数据库副本执行迁移。
5. 生成迁移预览。
6. 用户确认后原子切换活动数据库指针。
7. 旧数据库保持只读。

不修改真实 Codex Home、旧 DSH Home 或旧数据库。

### 17.2 native_mirrors 转换

| 旧状态 | 新状态 |
|---|---|
| 只有 Codex | codex_mirror |
| 只有 DSH | maintenance_native |
| 两端相同 | 一个 codex_mirror，旧 DSH ID 变历史别名 |
| Codex 单边更新 | codex_mirror 继续增量 |
| DSH 单边续写 | 建立 codex_derived |
| 双方不同续写 | Codex 原会话加独立 DSH 派生会话 |
| 无法确定共同基点 | 保留双方，标记待复核 |

无法确认基点时不自动合并。WebUI 显示双方静态内容和摘要，让用户确认。

### 17.3 binding_workspaces 转换

binding_workspaces 转成 logical_workspaces 和 workspace_memberships。

归属优先级：

1. 现有 Maintenance 明确归属；
2. 最近有效 DSH 归属；
3. 无法确定时进入未归类。

旧 native workspace ID 只保存为迁移来源和历史别名。

### 17.4 迁移报告

报告至少包含：

- 工作区数；
- 会话数；
- 版本数；
- 自动归类数；
- 待归类数；
- Codex 镜像数；
- DSH 原生会话数；
- DSH 派生会话数；
- 无法确认分裂基点数；
- 未知事件数；
- 内容和数据库摘要；
- 迁移前 Checkpoint；
- 回滚数据库路径。

## 18. 渐进验收策略

### 18.1 原则

首轮只验证关键路径，不预先覆盖所有版本、插件、浏览器和异常组合。

测试分四级：

1. Core Smoke：每次构建的最小主链。
2. Feature Check：只有声明某项能力时运行。
3. Failure Drilldown：关键断点失败后只测试对应区间。
4. Regression：保留已经真实发生过的故障。

所有自动测试使用合成 fixtures 和明确标记的临时目录，不读写真实 Codex、DSH Home。

### 18.2 Core Smoke

每个适配器初始只检查：

- probe；
- 一个会话物化；
- 一次原生追加；
- 一次规范提交；
- 一次正常关闭；
- 投影和真源摘要一致。

### 18.3 Feature Check

能力声明出现时才检查：

- Annotation；
- Sticker；
- Obsidian 深链接；
- Snapshot；
- borrowSession；
- 工作区热更新；
- unknown event round trip。

### 18.4 真实故障回归

初始回归集合只覆盖已经发生过的关键故障：

- Alpha1 拒绝未知 session/imported 事件；
- connection.api.sessions 被删除；
- dsh-client-runtime 被删除；
- uiConversation nodes 初始化为空；
- Obsidian Web Viewer 抢占或重复消费跳转；
- 引用删除未解除双链；
- 贴纸引用无法回跳或删除；
- DSH 回答后 Annotation 被过程折叠。

每个故障只对应一条聚焦测试和一个稳定错误码。

### 18.5 端到端人工验收

首个可用版本只执行一条主路径：

1. 打开 Maintenance WebUI。
2. 确认 Alpha2 Profile、适配器和 P1 至 P3。
3. 查看原有工作区和会话。
4. 打开一个 Codex 会话但不发送，确认不产生派生。
5. 在 DSH 续写一次，确认 P4 和 P5 成功。
6. 检查派生会话的工作区、标题、标签和来源。
7. 检查一个 Annotation、一个 Sticker 和一个 Obsidian 引用。
8. 正常关闭 Alpha2，确认 P8 和投影清理。
9. 启动 RC2，确认 P6 和同一工作区结构。
10. 在 Maintenance 删除测试会话，确认所有版本不再物化。
11. 恢复会话并确认重新出现。

浏览器控制用于观察和复现；最终交互验收由用户完成。

## 19. 首批落地顺序

### 19.1 Alpha2

先实现 Alpha2：

- 当前主要运行版本；
- 有正式 npm 包；
- sessionPersistence seam 已确认；
- Annotation、Sticker 和 Obsidian Bridge 已具备当前适配基础。

Alpha2 跑通 P1 至 P8 后，冻结 Adapter SDK v1 主接口。

### 19.2 RC2

RC2 复用 SDK，只实现 RC2 Engine Codec 和 Runtime Bridge。RC2 内部版本锁定细节封装在适配器包内。

### 19.3 未来版本

新 DSH 发布后：

1. 对最近适配器运行 probe。
2. 以 experimental 模式运行 Core Smoke。
3. 失败时根据状态断点缩小区间。
4. 更新或创建版本适配器。
5. 在 BREAKING-CHANGES 和兼容性矩阵登记。

## 20. 回滚与恢复

### 20.1 数据回滚

- 停止新 Engine；
- 确认没有活动写入租约；
- 保留新库和恢复材料；
- 把活动数据库指针切回迁移前只读副本；
- 不把新库反向覆盖旧库。

### 20.2 插件与 Profile 回滚

- Launcher Profile 切回旧 Generation；
- 保留失败 Generation、适配器构建和兼容性报告；
- 不删除失败组合，以便实验复现。

### 20.3 未提交写入

- 保留 WAL、投影、manifest 和状态日志；
- 先导出脱敏诊断包；
- 通过 operationId 确认、重放或隔离；
- 未经 Maintenance 明确操作不得物理清除。

## 21. Generation

通过关键断点后建立新的稳定 Generation，包含：

- Session Maintenance DSH 插件；
- Maintenance Engine；
- 独立 Dashboard WebUI；
- Adapter SDK；
- Alpha2 适配器；
- RC2 适配器；
- 当前确认兼容的 Annotation、Sticker、Obsidian Bridge 和相关插件；
- Launcher Profile 配置模板；
- 数据库迁移器；
- 迁移说明；
- 适配器兼容性矩阵；
- 关键断点验收报告；
- 回滚说明。

Generation 保存代码、配置和版本组合，不包含用户会话内容。Maintenance 数据目录独立于所有 Generation。

## 22. 安全与运行边界

- Engine 和 Dashboard 默认只绑定 loopback。
- 本地管理 API 使用会话认证，不把一次性启动 token 写入状态日志。
- 诊断包默认脱敏，不包含完整会话正文和模型密钥。
- Adapter Host 是进程隔离，不宣称操作系统沙箱。
- 真实删除只通过 Maintenance 墓碑和保留策略。
- 迁移、恢复和适配器测试不直接操作真实 Codex 或旧 DSH Home。
- 用户选择 experimental 适配器时记录选择和能力缺失，不以稳定标签误报。

## 23. 完成标准

本设计实现完成的最低标准：

1. Maintenance 独立数据目录保存逻辑会话与工作区。
2. Alpha2 和 RC2 顺序启动时看到同一逻辑结构。
3. Profile 停止后其 Home 不保留永久会话。
4. Codex 无变化扫描是空操作。
5. 仅打开 Codex 会话不创建派生。
6. 第一次 DSH 续写只创建一个派生会话。
7. 派生会话继承工作区、标题和标签，且无 Codex binding。
8. Annotation、Sticker 和 Obsidian 引用跨投影可保存、删除和定位。
9. Maintenance 删除会话后任何 Profile 都不再物化，且可恢复。
10. 正常关闭完成提交、Checkpoint 和投影清理。
11. 异常退出后未提交操作能够按 operationId 恢复。
12. Adapter SDK、示例、文档和 Core Smoke 对第三方可用。
13. 普通版本范围不硬锁实验适配器。
14. P1 至 P8 都有 started、succeeded 或 failed 状态日志。
15. WebUI 能显示会话、谱系、运行、适配器、Checkpoint 和诊断时间线。

## 24. 后续交付顺序

本规格终审通过后再进入实施计划。实施计划应按以下依赖顺序拆分：

1. 数据模型和只读迁移预览；
2. 状态日志基础设施；
3. Projection Lifecycle 与租约；
4. Adapter SDK 和 Alpha2 适配器；
5. 增量提交与 Codex 延迟分裂；
6. 正常关闭和异常恢复；
7. 逻辑工作区与独立 WebUI；
8. 删除、恢复和 Checkpoint；
9. RC2 适配器；
10. Launcher Profiles 与稳定 Generation；
11. P1 至 P8 端到端验收。

在用户完成本规格终审之前，不开始上述实现。
