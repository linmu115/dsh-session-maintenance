---
id: MOD-vault
kind: module
title: Vault 绑定与文件夹接入
status: current
summary: 管理已登记实例的 Vault 位置授权，独立于会话同步和插件数据投放。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/vault-bindings.ts}
  - {role: frontend, workspace_id: source, path: apps/dashboard/src/vault-binding-page.tsx}
---
绑定基于稳定实例身份、可核对的 Home/Profile 与所选文件夹，读取状态与写入授权分开。页面操作不修改会话真源或同步名单。宿主实例发现和物理访问仍属于 [[MOD-dsh-host]]；界面要求见 [[REQ-offline-vault-binding]]。
