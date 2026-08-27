# 恢复与回退

## 插件或 DSH 无法启动

1. 停止目标 DSH profile。
2. 恢复升级前保存的 profile `package.json`、lockfile 与旧插件 tgz 引用，或用官方 `plugin add <旧tgz>` 安装旧版本。
3. 保持 Engine state root 不变；不要删除 `transactions/`、`objects/` 或 `metadata.sqlite`。
4. 重启 DSH，先确认 loader 和会话可见，再恢复日常操作。

## Engine 中断

- 重启同一版本 Engine，并使用同一个 state root。
- 看板“恢复”页面会列出中断事务。`applying`/`verifying` 会先验证目标；能够证明已完成时只补记完成，否则使用该事务的已校验 backup 恢复。
- `manual-review` 不会自动继续。先查看 journal、backup hash、适配器契约和 Core probe，再签发一次性、作用域绑定的恢复确认。
- required backup 缺失、哈希错误或适配器漂移时禁止恢复，不能用空文件或另一个事务的快照替代。

## 回退 Checkpoint

Checkpoint 恢复不会覆盖当前 DSH 分支。它先生成可预览计划，确认后从所选版本建立新 DSH 分支；当前分支和之后的版本仍保留。

## Engine 连接轮换

Engine 重启会更新 `connection.json` 中的端口/capability。插件 host 会按 mtime 重读；如果仍显示离线，检查 DSH 进程是否继承了正确的描述符路径，然后重启 DSH。不要把旧 token 写回文件或插件设置。

## 最低救援原则

- 不直接编辑 DSH JSONL、workspace registry、projection cache 或 Codex rollout/SQLite。
- 不在没有完整 backup 与确认范围时执行强制删除或重置。
- 正式 profile 替换失败时恢复整个 package/lock/bundle 组合，而不是只复制一个 `node_modules` 子目录。
