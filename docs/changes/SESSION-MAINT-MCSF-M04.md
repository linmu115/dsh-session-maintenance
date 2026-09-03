# M04 — Alpha2 持久启动差量投影缓存

## 结果

- 投影缓存按 `Adapter 格式族 ID + 投影配置摘要` 复用，不再按单次 runId 重建。
- 首次使用建立完整、已验证的 Alpha2 基线；后续通过 Canonical Change Journal
  分页取得变化，并只加载受影响会话正文。
- 无变化时不加载 Canonical 会话正文，不读取或改写已有 Alpha2 会话文件。
- 会话新增、修改和墓碑按 native ID 精确写入或移除；Adapter 指纹变化时通过
  staging 目录完整重建后原子替换旧缓存。
- Cache Manifest 保存 last-applied Revision、Adapter 指纹、每会话 digest、
  native revision 与运行恢复所需的轻量元数据；不保存消息、工具调用或附件正文。
- Schema v15 补齐工作区定义、项目定义和项目根变化的 Journal 触发器。

## Adapter SDK

Alpha2 Adapter 新增 `composeProjectionManifest`。它从缓存的 session digests 和
workspace IDs 组合完整 Projection Manifest，不打开未变化会话正文。公开 Authoring
Guide 明确 Adapter ID 表示兼容的原生格式族；发生破坏性格式变化时必须新增并人工
审核 Adapter，不能自动猜测字段。

## 诊断断点

`projection.delta-apply` 只记录：from/through/current Revision、变化会话数、实际
改写数、删除数、未改动数和工作区变动数。诊断不记录标题、消息或原生 payload。

## 验证范围

- 严格契约与 Cache Manifest 不变量；
- 首次基线、无变化复用、单会话更新、墓碑删除；
- 不同配置隔离及 Adapter 指纹变化后的重建；
- Schema v15 迁移与工作区/项目变化 Journal；
- Alpha2、Projection Lifecycle、Contracts 和 Session Store 聚焦类型检查。

真实 Codex Home、真实 DSH Home、Launcher 和 Generation 均未写入或构建。
