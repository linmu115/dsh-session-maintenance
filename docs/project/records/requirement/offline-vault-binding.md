---
id: REQ-offline-vault-binding
kind: requirement
title: Maintenance 内按已登记实例管理 Vault 绑定
status: current
---

2026-09-19 用户在当前任务要求并授权开始修改：绑定管理不依赖 DSH 启动；先列已登记实例，点击弹出绑定卡片，Vault逐行展示和解绑，列表右上角新建绑定打开本机文件夹选择，沿用Vault及桥插件版本检查。此要求替代此前经在线DSH信息页执行绑定的入口约定。

Maintenance负责实例选择与管理流程；Obsidian桥仍为绑定唯一持久写入方。目标是稳定instance/profile，与boot/端口分开。保留CAS、操作幂等、复制Vault路径证明和冲突拒绝；不将离线DSH管理授权用于Viewer或会话写入。DSH不必运行；Obsidian Vault仍须打开并启用兼容桥，新旧桥能力明确区分。开发与验收使用合成目录，不改真实绑定。
