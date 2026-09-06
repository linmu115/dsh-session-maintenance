# 恢复点源版本能力查询

新增只读 `GET /v1/checkpoints/:id/restore-capability`，经过既有统一鉴权，返回 `{ capability: { checkpointId, supported, reason } }`。Engine 与客户端方法为 `getCheckpointRestoreCapability(checkpointId)`；客户端另接受可选 `AbortSignal`。DTO 和严格响应 schema 统一保存在 contracts。

`supported` 只说明恢复点保存的源版本适合现有旧版恢复预览，不表示目标可写或已执行恢复。没有 WriteService 的只读 Engine 返回不支持。查询不会创建计划、写入事务、探测目标平台或变更真实会话。

新的共享源解析器同时供能力查询与 `createCheckpointRestorePlan` 使用：保持唯一 `session:` 引用优先、否则唯一引用的既有选择规则；核对版本和会话引用；读取并验证 `normalizedSessionSchema`；核对来源绑定、逻辑会话与平台会话标识。Canonical 对象明确返回当前旧版恢复预览不支持的中文原因。缺失、损坏、无法读取或绑定不一致均不得声明支持；错误原因不会泄露底层路径。实际创建预览时仍执行原有目标实例和写入探测检查。

针对复审发现的有效对象调换风险，源解析器还会核对对象内 `bodyHash` / `metadataHash` 与选中版本清单一致，并重新计算语义摘要，拒绝修改正文、工作区、标题或归档状态却沿用旧摘要的对象。版本 ID 本身不包含 `bodyObject`，因此仅校验版本 ID 和对象 schema 不足以证明读取了所选版本的内容。

`packages/session-domain/src/normalize.ts` 抽出 `normalizedSessionHashes`，让规范化生产端和恢复源读取端复用同一个原有算法。正文继续使用 `schemaVersion`、`workspaceId` 和 `normalizedEventForHash`；元数据继续使用 `title`、`archived`。没有复制摘要算法或修改 `discovery.ts`。固定合成样本从抽取前的生产实现记录了正文摘要、元数据摘要和完整规范化 JSON 摘要，重构后三者完全一致。

没有新增 Canonical 恢复写入或手动恢复点创建能力。测试只使用内存合成对象和带标记临时目录。主控统一提交本变更。

验证结果：

- `pnpm exec vitest run apps/engine/test/checkpoint-restore-capability.test.ts packages/local-api-client/test/checkpoint-restore-capability.test.ts packages/session-domain/test/normalize.test.ts tests/integration/dsh-safe-fast-forward.test.ts --maxWorkers=1 --testTimeout=15000`：摘要修复后的最终 4 个文件、32 项测试全部通过（Engine/API 20、client 5、normalize 6、旧版恢复回归 1）。覆盖旧引用选择兼容性、Canonical 明确拒绝、缺损对象/引用/绑定、只读 Engine、API 鉴权、客户端 DTO 与取消信号，以及同 key 的有效正文/元数据对象调换和携带陈旧摘要的语义变更。真实 SQLite fixture 将选中版本的对象指针改为另一份有效对象，在 `getVersion` 仍接受相同版本 ID 时，能力 API 与旧版恢复预览均拒绝，且不保存计划。Canonical 预览同样被拒绝，两个标记平台目录查询前后的哈希一致。既有 DSH 安全恢复预览与执行回归继续通过。
- contracts、local-api-client、Engine 的 TypeScript typecheck：通过。共享解析器使用 SessionRepository 与 TransactionRepository 的只读接口组合。
- `git diff --check`：通过。

本机沙箱曾阻止测试/类型检查工具启动编译子进程（`spawn EPERM`）；经自动审批后运行相同的合成测试命令成功。没有连接真实平台 home，也没有启动真实 Launcher。提交由主控统一完成。
