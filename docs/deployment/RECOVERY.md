# 恢复与回退

## 当前 Canonical 运行

先保留故障现场，再确认运行租约、待提交写入、WAL 和最终回执。进程退出、目录仍在或状态为 quarantined 都不能单独证明可删除。不要手工删除运行目录、投影缓存、对象或 Provider handle 来解除阻塞。

- Engine 中断后优先用同版本、同 state root 重启，保留原有操作 ID 和恢复证据。
- 正常停止先由插件排空追加，再由 Provider/Runtime Broker 完成收尾；启动失败走 `abort`，退出后走 `afterExit`。不要把重复通知变成新的业务提交。
- 无法确认已提交的尾部或最终摘要时保留隔离运行，检查运行状态和日志后按相应修复说明处理；不要伪造回执。
- Codex 源仍只读。恢复不能编辑 Codex rollout/SQLite，也不能复活旧 Native Mirror 同步链。

## 插件、宿主或构建回退

1. 正常停止目标 DSH，确认写入排空及恢复状态后停止 Engine。
2. 恢复旧完整 Engine 构建、匹配插件与 profile package/lock/bundle 组合，以及匹配的 Launcher Hook 配置/宿主版本。
3. 仅在旧二进制支持当前 schema 时沿用当前库；否则使用升级前经过校验的完整备份组合，保留升级后的状态供核对。不要只把 `databaseFile` 改回任意旧库：正文对象、运行证据与库引用必须一致。
4. 重启 Engine 与 DSH，先验证加载、连接、会话身份及内容，再恢复日常使用。

Dashboard 自动发现补丁 `a6b4053` 本身无数据库迁移；其他版本不继承这一回退保证。Checkpoint 仅是版本引用，不能代替完整备份，也不应直接改写现有版本 ID 或父关系。

## 历史 RC2 Gateway 事务

早期事务通道的 journal、backup、`applying` / `verifying` / `manual-review` 状态与当前 Canonical 运行恢复不同。仅在实际启用了匹配的 RC2 Core Gateway 且存在对应事务时，使用其事务恢复流程：先验证目标与备份摘要，无法证明时保留人工复核；缺失备份或契约漂移不能强制继续。当前 CLI `apply` / `restore` 返回不可用，不能作为通用 Canonical 恢复命令。

## 连接与数据保留

Engine 重启更新 `connection.json` 的端口/capability；插件 host 按 mtime 重读。离线时先检查进程继承的描述符路径和 state root，不把旧 token 写回。看板 404 与健康接口正常可以同时发生，应核对构建是否包含 Dashboard 及启动目录配置。

不要直接编辑 DSH JSONL、workspace registry 或 projection cache。卸载不会删除 Canonical 当前内容与历史。五天历史窗口和引用安全回收仍是施工计划内容，并非当前可按文件日期手工清理的规则。
