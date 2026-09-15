# 原生上下文释放的持久证据核验

Engine 不以宿主传入的 `state=applied` 或字节数作为实际释放证明。DSH 0.1.5 Adapter 现在提供：

- `verifyV3NativeContextMaterials`：从已持久化的原生 projection 数据核验材料事件、稳定 ID、内容摘要、字节数、来源持有者和范围。
- `verifyV3NativeContextRelease`：核验相同材料在当前原生 surface 中已有有效替代，再返回真实事件位置、实际释放字节数和证据摘要。

两者先使用官方 v3 格式恢复和 `foldSurface`。工具结果的调用身份、源、meta 和协议配对由 DSH 自身规则保护；Adapter 再逐项比较替代 JSON，确保只改变声明释放的条目，保留兄弟片段、分页定位和未释放材料。初始 Annotation 包保留用户 comment、真实用户消息、其它引用及共享文档。

材料的 key 继续使用原 Annotation 条目身份；来源持有者使用 `locator.upstream.referenceId` 解析的权威引用身份。该区别同样应用于共享文档。用户请求目录的原文分页范围使用 Unicode 码点；既有上游与初始问答范围保持 UTF-16 位置，避免混用坐标。

只有从原事件或本协议的先前替代事件延续的单节点链才可确认。若原节点已被其它原生裁剪器替代，不允许借释放操作重新展开原文。未持久、源身份不匹配、材料摘要不一致、marker 伪造、调用身份变化、其它条目被修改和陈旧 surface 位置均拒绝确认。

同一原节点后续可再次释放其它片段；前一个操作重试时核验当前 surface，但字节数只计算该操作的首次实际替代差值，避免重复计入以前释放的材料。

合成测试使用完整的原生 turn/step/tool-call/result 历史及实际官方 surface 验证，覆盖工具局部释放、双次释放与冷重试、Annotation 混包、UI 引用 ID 与权威 ID 不同、共享持有者、伪造材料/回执、协议配对和外部裁剪不复活。未修改真实会话或模型输入。

## 跨仓与完整持久链验收

已将 Annotation Core 实际脚本化 `AgentLoop` 导出的合成 native 事件、材料和回执保存为提交内的协议 fixture。该 producer 使用官方 `agent.inject(context)` / `followup(user)` 路径建立 system head，再经过真实 DSH 工具执行与 `agent/pre-step`，共三次请求装配；provider 是本地脚本，未调用网络模型。

`apps/engine/test/native-context-durable-loop.test.ts` 通过两项检查：

1. 当前 Adapter 的严格 v3 和 surface 校验接受真实 Core producer，材料摘要及释放字节数完全一致。
2. Engine 先持久追加替代前缀、登记同份真实材料并保存 pending 释放计划。替代事件尚未提交时拒绝 `applied`；提交真实替代尾部后确认生效。宿主伪报的 `999999` 字节被忽略，Engine 从原生日志自行算出实际值；重复回执不增加修订，原始用户与会话 canonical 内容不变。

初期 fixture 曾因内存 Session 缺少必填 header、手工插入 Annotation 早于 protected system head 而被严格格式边界拒绝。最终 fixture 修复了官方初始化顺序，没有放宽生产校验。这项验收包含从真实 producer 到 Maintenance durable append 的完整链路。
