---
id: IF-plugin-data
kind: interface
title: 插件原数据的采集与目标映射
status: current
summary: Maintenance 保存带来源的原始值，插件适配器握手、选择投放位置并通过插件正常读取路径验证。
sources:
  - role: contract
    workspace_id: source
    path: packages/contracts/src/plugin-data-mapping.ts
  - role: provider
    workspace_id: source
    path: packages/adapter-lynn/src/runtime.ts
  - role: consumer
    workspace_id: source
    path: plugins/dsh-session-maintenance/src/host-workspace-sync.ts
---
一条记录包含 namespace、dataType、recordId 和不透明 value。目标包含端点、目标会话及适配器使用的宿主上下文；核心不解释这些字段。插件适配器先与实际运行的插件握手，采集自己拥有的数据；恢复时按目标和记录身份幂等投放到插件正常使用的位置，之后经插件平时的读取接口 verify。可选的 withAccess / validate 在原生写入前封住并发插件修改。

例如 Lynn 将某会话贴纸状态映射到目标会话的 StickerLocalStore，再由贴纸插件的读取路径确认；GPT 事件由独立 GPT 适配器处理。目标缺插件或握手失败时不投放，但真源记录保留。未知结构化数据打包保留并在阅读器折叠，不能凭类型猜一个插件，也不能以“文件写入成功”替代功能读回。

接口提供方是对应适配器，消费方是宿主写回与目标插件。新增插件数据类型时新增或扩展该插件适配器；无需把其业务模型加进 Maintenance 核心。
