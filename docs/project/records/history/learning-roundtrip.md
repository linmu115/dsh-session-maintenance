---
id: HIST-learning-roundtrip
kind: history
title: 学习会话双向维护的范围收敛与回收锁
date: 2026-09-17
status: current
modules: [运行时投影, 看板, Codex 适配]
outcome: 已记录需求与待实现验收，尚未修改产品或真实会话
summary: 从双端完整投影讨论收敛为完整看板的实验栏目，Codex 阅读呈现可选，正文连续和无分叉回收必需。
applicability: 首个目标为机试DeepLearning，仅限已确认双端绑定的学习型问答。
coverage_note: Codex 于 2026-09-17 整理；来源为本任务第 899–969 行公开消息与接口检查，包含用户两次批注纠偏，不包含隐藏推理和此前修复任务。
history:
  path: history/20260917-learning-roundtrip-requirements
  sha256: 9866c1e1b8d05421ff0f4131fe24b1cc794be8b7d4a90eeccd18f5a64a3cf1ec
  capture_sha256: e06b86156a26685926f3bf308cbc20f21dd4a7905cc52398a7d7d368a45adab5
related_records: [REQ-learning-roundtrip, OBJ-session, MOD-dashboard, MOD-continuation]
---

# 学习会话双向维护的范围收敛与回收锁

用户希望在 DSH 与 Codex 轮流学习，首个目标只有“机试DeepLearning”，由 Maintenance 保存同一主线，扩展业务数据不必跨端投影。

[查看依据：初始学习会话双向维护需求](history-event:EVT-c000b650abd1f1bf8e36)

初步方案提出两端切换按钮及逐条问答投影。用户指出 Codex 前端无法修改，并明确不希望新交接任务被再次导入为 DSH 镜像，也不接受 DSH 正常续写再派生分支。方案据此改为从 DSH/Maintenance 发起双向操作、保持绑定身份、增量回收而非用对端历史覆盖真源，并携带引用文本快照。

[查看依据：用户纠正前端入口、身份和历史保留要求](history-event:EVT-2c085418deff687c22d7)

只读检查发现现有续接通过新建 Codex 任务并发送交接消息实现，且版本检查固定 0.146.0；本机 CLI 为 0.153.4，生成的 schema 包含 thread/inject_items。此证据仅支持存在候选接口，没有测试真实注入、模型请求或桌面显示。

用户进一步明确：Codex 接收到上下文并能继续回答即可，桌面逐条显示是可舍弃增强；回收时必须保证同步期间 DSH 没有新增内容，Codex 新追加晚于同步时刻，出现分支差异则禁止追加。功能属于 Maintenance 的实验能力，放入完整看板的独立栏目，只纳入确认关联的会话，并继承迁移维护功能。

[查看依据：回收锁、阅读降级与实验栏目要求](history-event:EVT-c622621a4986bea3fb72)

需求与验收记录在 [[REQ-learning-roundtrip]]。为使用户条件可靠落地，提出版本/游标、注入项排除、提交前复查及幂等回执作为待实施设计；这些细节属于工程建议，不冒充用户逐字要求。当前只完成需求记录和地图关联，不声称已经创建绑定、上线栏目或通过双向交接验收。
