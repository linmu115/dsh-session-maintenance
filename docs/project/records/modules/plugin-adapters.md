---
id: MOD-plugin-adapters
kind: module
title: 插件数据适配
status: current
summary: Lynn 综合当前插件组合，GPT compat 独立；对应插件在握手后恢复数据到自己的正常读取位置。
relations:
  - relation: implements
    to:
      record_id: REQ-opaque-mapping
    reason: 保留并正确投放插件原数据
  - relation: implements
    to:
      record_id: REQ-lynn-gpt
    reason: 两个适配器按确认组合独立装配
  - relation: provides
    to:
      record_id: IF-plugin-data
    reason: 对宿主写回提供插件映射实现
sources:
  - role: implementation
    workspace_id: source
    path: packages/adapter-lynn/src/runtime.ts
  - role: implementation
    workspace_id: source
    path: packages/extension-gpt-compat/src/mapping.ts
  - role: implementation
    workspace_id: source
    path: apps/engine/src/adapters/lynn/composition.ts
---
`packages/adapter-lynn` 对当前 Core、会话扩展数据、ThoughtDAG 和贴纸组合按成员握手，采集原始记录；按目标身份映射至插件自己使用的存储，并通过其正常读取接口验证。它有自己的插件写入屏障，不能用“配置里有名字”代替握手。未知 namespace 或缺少目标插件时保留源记录，不猜测投放位置。外部 Vault 文档与机器绑定不跟随会话复制。

`packages/extension-gpt-compat` 是独立适配器，处理 GPT 事件及过滤、派生后的序号和引用重映射。Lynn 和 GPT 的业务规则不进入规范核心。`apps/engine/src/adapters/lynn` 装配旧图、引用、知识与业务 API 的兼容入口；这仍是当前代码存在的具体插件装配，不意味着全局边界已完全清理。

唯一通用映射合同见 [[IF-plugin-data]]。目标是否真正保留插件功能，需要在对应插件读写路径验收；持久化成功本身不够。
