---
id: IF-extension
kind: interface
title: 业务对象怎样交给 Maintenance 管理
status: current
summary: 插件交付身份、归属和预期修订，Engine 提供保存、冲突与目录。
relations:
- relation: derived_from
  to:
    record_id: REQ-ownership
sources:
- path: ../../packages/contracts/src/extension-data.ts
- path: ../../packages/contracts/src/extension-directory.ts
- path: ../extensions/plugin-data-integration.md
- path: ../../apps/engine/src/extensions/adapters.ts
- path: ../../plugins/dsh-session-maintenance/src/extension-data.ts
---

# 业务对象怎样交给 Maintenance 管理

2026-09-22 用户修正：Maintenance 只忠实记录插件数据、类型和来源；目标插件 adapter 自己握手、定位目标会话、恢复数据并用插件正常读取路径验证，缺插件时不映射且不删源数据。新增 [功能恢复协议](../../../../../../packages/contracts/src/plugin-data-mapping.ts) 和[当前实现/验收边界](../../../../../changes/2026-09-22-host-write-barrier-and-plugin-mapping.md)。下面已有“图领域限制”等条款描述尚未迁完的旧实现，不表示核心继续拥有插件业务模型。

贴纸插件保存属于 Y 的 stickers 对象，携带 logicalSessionId、writerId 与 expectedRevision；Engine 核验实例、能力、schema 后返回 revision，冲突返回双方候选。调用方保留未确认编辑。

唯一技术合同：[ExtensionDataAdapter 与写入 DTO](../../../../../../packages/contracts/src/extension-data.ts)、[面板、归属及镜像 DTO](../../../../../../packages/contracts/src/extension-directory.ts)。[公共接入指南](../../../../../extensions/plugin-data-integration.md)保留首版说明，当前能力以 [内置注册实现](../../../../../../apps/engine/src/extensions/adapters.ts)为准。

提供方 [[MOD-extension-store]] 管存储、版本和冲突，Adapter 解释格式与所有者。消费宿主经 [MaintenanceExtensionBridge](../../../../../../plugins/dsh-session-maintenance/src/extension-data.ts) list/get/save，浏览器经自己的业务授权路由，Engine 凭据留宿主。

writerId 和 expectedRevision 必须匹配，references 不是归属。停用/缺 Adapter 保留通用元数据和对象，正文/写入按各成员能力检查；卸载、离线、某页缺席不能代表删除。

**领域限制**：managedSchema 2 图走 [[IF-graph]]，annotation-records 走可信同步，annotation-context 走 [[IF-native-context]]；普通保存不能绕过。通用 Adapter 的 context:false 表示不自动供给模型，不否认独立原生上下文能力。

接入目录 [[INT-business-directory]]；改合同同步 DTO、schema、ownership、兼容声明及具体消费者。

## 插件的原生扩展事件

兼容其它插件的会话数据，应先构建扩展数据 Adapter。声明 namespace、pluginVersions、schemaVersions、capabilities、ownership；若数据嵌入宿主日志，用 nativeEvents 声明 hostAdapterId、精确事件类型集合和校验器，并在受信组合层提供完整 codec。插件 payload 不能自行注册可执行代码。

Harness 负责宿主实例迁移和 framing，扩展 Adapter 负责插件字段语义；添加 checkpoint/replay 事件不产生新的 Harness ID。只读索引可按实例/Profile/逻辑会话建立，原始事件仍保留在版本真源，索引不能成为另一套重放状态。

实例见 [[INT-gpt-format]]。新增接入必须验证栏目和所有权、启停、旧事件恢复、密文往返、非法引用、并发修订及宿主身份不变。

## 公开业务信息页的后续合同

当前数据读写 DTO 与领域限制保持。已确认待实现的页面／栏目注册见 [[IF-extension-pages]]，实例工作区与会话可用性查询见 [[IF-instance-workspace-scope]]；这些草案不代表已有公共方法，也不把每个 namespace 强制变成一页。
