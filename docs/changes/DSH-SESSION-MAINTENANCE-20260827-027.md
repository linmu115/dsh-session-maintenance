# P27：显式双父解析版本

## 结果

- 新增 resolution preview/create 深 Module 入口；只有明确提交左右版本、合并说明和目标 preset 的请求才能建立双父解析。
- Engine 验证两个版本属于同一逻辑会话、彼此确实分叉，并验证或自动解析共同祖先；相同版本或非分叉关系失败关闭。
- 解析版本拥有两个原始父 ID，正文只保存用户合并说明、共同祖先、两边 body hash 和来源身份；不会把两条消息序列重排成一条虚假时间线。
- 交接包仍将左右历史分区展示；DSH 工具记录继续保持“导入记录”语义。
- 新 Codex 任务的 binding 指向解析版本；原始 DSH/Codex refs 和 observed head 不移动。
- request hash 包含解析版本身份；相同双父、说明、目标和模式重复创建返回同一作业，`thread/start` 只执行一次。
- CLI、loopback API、local client 与 Codex MCP/Skill 均增加显式 resolution preview/create 入口。

## 验证

- 扩展既有 Phase 3 集成场景，不增加新的重复测试套件。
- 集成场景检查双父顺序、共同祖先、合并说明、两个来源 hash、原 DSH head 不变、Codex binding 指向解析节点以及创建幂等。
- handoff + Phase 3 两个目标测试通过；contracts、continuation-engine、local client、app engine 定向 typecheck 通过。
- Codex plugin validator：通过。
