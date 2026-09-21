---
id: MOD-canonical
kind: module
title: 会话真源、导入与维护
status: current
summary: 稳定观察交给 Engine 建立身份、版本、工作区与来源谱系。
relations:
- relation: consumes
  to:
    record_id: IF-harness-adapter
  reason: 稳定观察及平台规范化
- relation: implements
  to:
    record_id: REQ-product
sources:
- path: ../../packages/canonical-session-engine/src/engine.ts
- path: ../../apps/engine/src/codex-import-service.ts
- path: ../../apps/engine/src/codex-project-mapping.ts
- path: ../../apps/engine/src/session-maintenance-commands.ts
---

# 会话真源、导入与维护

CodexReadAdapter / DshReadAdapter 只读观察并规范化；Engine 选择导入范围，记录来源绑定和版本。Codex 项目映射控制纳入范围及同步策略；投影准备成功不证明新的 Codex 正文已全部导入。

CanonicalSessionEngine 的 observeCodex、importDshNative、appendDsh、tombstone/restore 统一提交正文对象、版本头、成员关系、谱系和回执。Codex 镜像第一次实际 DSH 追加创建派生身份。

2026-09-21 用户注释改变的入库前提（尚未实现）：来自 DSH 侧的改动只认**已绑定实例在同步工作区内**产生的会话；实例自带工作区不自动登记为真源工作区。被显式加入的工作区应当在 **Maintenance 自己维护的会话存储区域中新增一个文件夹**，并把 DSH 会话映射成它自己的存储形式。此前的「原生新会话一律登记进真源（`importDshNative` 路径）」不再是默认规则。见 [[DEC-directory-connect-sync-authority]]、[[REQ-detached-instance-attach-sync]]。

检查点、比较、计划写入与恢复保留 WriteService/TransactionExecutor 边界；早期 DSH Gateway 写适配器仍有代码，不是当前原生逐条追加链。

入口：[CanonicalSessionEngine](../../../../../../packages/canonical-session-engine/src/engine.ts)、[Codex 导入](../../../../../../apps/engine/src/codex-import-service.ts)、[项目映射](../../../../../../apps/engine/src/codex-project-mapping.ts)、[维护命令](../../../../../../apps/engine/src/session-maintenance-commands.ts)。
