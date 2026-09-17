---
id: MOD-harness
kind: module
title: Harness／平台适配器
status: current
summary: 适配宿主会话格式、稳定观察、版本、投影和运行证据。
relations:
- relation: provides
  to:
    record_id: IF-harness-adapter
- relation: implements
  to:
    record_id: REQ-adapter-families
sources:
- path: ../adapters/architecture.md
---

# Harness／平台适配器

本分支处理 Codex/DSH 平台差异，不解释贴纸、笔记或图布局。Engine 选择逻辑身份、版本与租约，Adapter 接收受控 DTO 和证据入口。

- [Codex：只读来源与原生续接](codex.md)：Codex 只读导入及独立原生续接端口。
- [DSH：读取与原生格式族](dsh.md)：DSH 读取和不同原生格式族的编码、追加、恢复。
- [平台合同](contract.md)：共享技术类型与 SDK 合同入口。
- [平台已知接入](connected.md)：已核实实现、调用者及版本证据。

业务对象分支是 [业务数据适配](../business/overview.md)。两类注册、兼容和启用列表独立，不能用平台适配能力授权业务 namespace。依据 [平台信任边界](../../../../../adapters/architecture.md)。
