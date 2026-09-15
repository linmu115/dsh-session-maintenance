# 业务扩展目录与引用条目镜像

本次把扩展面板的展示归属与内部数据域分开。Obsidian 系列聚合引用、贴纸及知识链接，ThoughtDAG 聚合主干图和附属读取记录。内部 namespace、写入方、版本兼容、冲突修订和领域授权仍分别管理。

## 目录与归属

- 新增 `ExtensionBusinessPanel` 与 `ExtensionDirectoryPage`，由可信 Adapter 声明展示分组和对象所属会话。通用 `references` 仍表示关联，不参与所有者推断。
- 跨会话引用归 `targetSessionId`；普通/会话贴纸及笔记链接归 `logicalSessionId`；主干图和披露日志归 `ownerSessionId`。
- 无法核验的旧图、旧多目标链接、旧原生身份引用集合进入 `@unbound`，不选取第一个关联会话作为所有者。
- 工作区与当前原生会话维护页一致，使用 `workspace_memberships` / `logical_workspaces`。嵌套工作区显示有限深度、循环保护的完整路径；无工作区为 `@ungrouped`。目录跟随会话移动，条目不复制工作区身份。
- 会话与对象的归档标记同时读取逻辑会话状态和工作区 membership 归档状态；一个子会话归档不会让整个工作区显示为归档。
- 默认目录只列顶层条目。`disclosure-log` 通过 `parentObjectId` 在主干下读取；查看历史附属记录可使用 `deleted=all`，因为日志不随主干一起设置删除标记。
- 面板业务数量与默认 `deleted=active` 的顶层目录使用相同规则，排除附属日志和重复镜像。仅会话归档、对象未删除的记录仍计数并标记归档；已随主干归档而设置删除标记的图从默认计数排除。字节量与冲突量保留内部数据域总量。
- 图领域对象、上游授权关系与引用镜像在通用面板只读，修改继续使用其各自领域接口。

## API

- `GET /v1/extensions/business-panels?instanceId=&profileId=`：按业务 Adapter 聚合，每个成员保留兼容与启用状态；存在不同成员状态时返回 `partial`。HTTP 层使用已注册实例的 `displayName`，没有额外探测宿主。
- `GET /v1/extensions/directory`：必填 `instanceId`、`profileId`、`adapterId`、`level`；`level` 是 `workspaces`、`sessions` 或 `objects`。会话层要求 `workspaceId`，对象层要求 `ownerSessionId`；可选 `parentObjectId`、`deleted`、`after`、`limit`。
- 每页默认 30，最大 100。游标绑定实例、profile、Adapter、层级与筛选条件，不能跨目录复用。目录结果只包含元数据，正文仍通过已有详情接口按需读取。
- SDK 增加 `listExtensionBusinessPanels`、`listExtensionDirectory`、`syncAnnotationMirror`；原 namespace 接口保持兼容。

## 可重建索引

数据库 schema 升至 24，新增 `extension_object_owners`，保存对象修订、提取器版本、所属会话、类型和附属关系。索引缺失或对象修订改变时分批重建，显式重建也不会改写对象正文、对象版本、会话历史或头版本。

索引解释由受信的 Adapter 代码完成；不兼容或格式异常的对象保留为待核验条目。卸载 Adapter 不删除原对象。新增 schema 24 同时加入静态恢复点和保留规则的已知只读 schema 范围，旧 schema 21–23 仍可识别。

## Annotation Core 轻量镜像

新数据域是 `annotation-records`，schema 1，兼容 Core `0.3.12-rc2.9` / `0.3.12-rc2.10`，唯一同步写入方为 `dsh-annotation-core`。通用扩展写入拒绝修改该域。

`POST /v1/extensions/annotation-sync` 接受 `runId`、`nativeSessionId`、数值 `sourceRevision` 和最多 50 个轻量条目，HTTP 请求上限为 512 KiB。条目仅包含引用/集合身份、来源类型、状态、有限选区与评论以及定位元数据；严格 schema 不接收全文快照、提交日志或调用方指定的逻辑目标身份。

Engine 通过当前 run 的原生会话映射解析目标和来源逻辑会话。目标未就绪时请求可重试；来源未就绪时逐项返回 `deferred`，不建立无归属对象。每条镜像独立比较 Core aggregate 的 `sourceRevision`：相同版本和内容幂等，旧版本返回 `stale`，同版本不同内容返回 `conflict`。同一 aggregate 修订可以安全分成多页同步。

同步仅处理显式条目和正向删除记录，缺席不批量删除。首次收到删除记录也建立删除态镜像，阻止旧导出复活；删除时保留既有上游关联身份。逐项持久回执包含 `referenceId`、稳定 `objectId`、对象修订、来源修订和结果状态。

如果镜像提供 `source.upstreamReferenceId`，同一实例/profile/目标会话下已存在对应 `annotation-upstream` 权威对象，目录只显示该权威引用，避免重复计数；镜像原记录仍保留。镜像不会创建读取授权、修改上游引用或伪造提交回执。Core 原 storage domain 仍管理 pending/sent sets、提交状态和 outbox。

未迁移普通贴纸仍需要原迁移流程，已有轻量目录不会凭空补齐尚未接入的数据。

## 验证

均使用标记的合成临时目录，无真实模型调用或真实用户 Home 修改。

- `apps/engine/test/extension-directory.test.ts`：9 项通过；覆盖显式所有权、namespace 聚合与兼容、工作区移动/归档、索引重建不修改权威对象、未绑定组、日志附属、范围游标、镜像幂等/旧版本/冲突/删除/去重、非法正文与身份拒绝、未就绪重试。
- 同一测试包含真实 Engine HTTP 与 RC2 run 的会话注册、Engine 身份映射、成功镜像同步及重试；合成原生 Home 哈希保持不变。
- `apps/engine/test/extension-data.test.ts`：10 项通过，原写入方、冲突、删除恢复和 managed graph guard 保持生效。
- `packages/session-store/test/retention-schema21.test.ts`：9 项通过，覆盖 schema 21–24 静态引用读取、未知版本拒绝及损坏外键拒绝。一次默认 5 秒时限下的环境超时，使用 15 秒时限复核通过。
- Engine、contracts、session-store 类型检查通过；SDK 新增方法的 tuple 类型已修正。全工作区最终检查由主任务统一执行。

本变更记录只覆盖后端与契约；页面、Core 导出、Host 同步任务及实际副本部署由对应改动分别记录。
