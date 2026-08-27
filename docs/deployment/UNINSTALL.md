# 卸载

卸载入口和删除会话数据是两件事。默认卸载只移除 DSH 插件，保留 Engine 状态、对象、事务备份、Checkpoint、Codex/DSH 原始会话以及旧插件数据。

1. 停止目标 DSH profile。
2. 使用官方插件命令：

```powershell
node $dshBin plugin --profile web remove dsh-session-maintenance
```

3. 从 DSH 启动环境中移除 `DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY`。
4. 重启 DSH，确认插件入口和两个 host endpoint 已消失，其他会话仍可见。
5. 如不再使用独立看板，停止 Engine。保留 state root 即可随时重装。

只有在另一个独立、明确确认的清理任务中，才删除 Engine state root 或旧同步插件 ledger。不要把卸载插件误当作删除历史。
