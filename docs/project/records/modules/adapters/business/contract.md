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

贴纸插件保存属于 Y 的 stickers 对象，携带 logicalSessionId、writerId 与 expectedRevision；Engine 核验实例、能力、schema 后返回 revision，冲突返回双方候选。调用方保留未确认编辑。

唯一技术合同：[ExtensionDataAdapter 与写入 DTO](../../../../../../packages/contracts/src/extension-data.ts)、[面板、归属及镜像 DTO](../../../../../../packages/contracts/src/extension-directory.ts)。[公共接入指南](../../../../../extensions/plugin-data-integration.md)保留首版说明，当前能力以 [内置注册实现](../../../../../../apps/engine/src/extensions/adapters.ts)为准。

提供方 [[MOD-extension-store]] 管存储、版本和冲突，Adapter 解释格式与所有者。消费宿主经 [MaintenanceExtensionBridge](../../../../../../plugins/dsh-session-maintenance/src/extension-data.ts) list/get/save，浏览器经自己的业务授权路由，Engine 凭据留宿主。

writerId 和 expectedRevision 必须匹配，references 不是归属。停用/缺 Adapter 保留通用元数据和对象，正文/写入按各成员能力检查；卸载、离线、某页缺席不能代表删除。

**领域限制**：managedSchema 2 图走 [[IF-graph]]，annotation-records 走可信同步，annotation-context 走 [[IF-native-context]]；普通保存不能绕过。通用 Adapter 的 context:false 表示不自动供给模型，不否认独立原生上下文能力。

接入目录 [[INT-business-directory]]；改合同同步 DTO、schema、ownership、兼容声明及具体消费者。
