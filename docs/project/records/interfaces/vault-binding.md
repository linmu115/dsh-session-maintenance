---
id: IF-vault-binding
kind: interface
title: 实例 Vault 绑定身份与授权
status: current
summary: 以稳定实例身份和所选 Vault 路径建立或解除绑定，读状态不隐式写入。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/vault-bindings.ts}
  - {role: consumer, workspace_id: source, path: apps/dashboard/src/vault-binding-page.tsx}
---
绑定请求携带经核验的实例 ID/Profile/Home 与用户所选文件夹；提供者返回身份、权限及持久结果。只读列表和状态检查不更改绑定、同步名单或笔记。解绑是独立写操作，不能被实例健康检查触发。具体页面交互见 [[REQ-offline-vault-binding]]。旧合同位置：`d3fdbe3:docs/project/records/interfaces/offline-vault-binding.md`。
