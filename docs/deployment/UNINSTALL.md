# 卸载

卸载入口和删除会话数据是两件事。默认卸载只移除 DSH 插件，保留 Engine 状态、对象、事务备份、Checkpoint、Codex/DSH 原始会话以及旧插件数据。

1. 在 Engine 仍运行时正常停止目标 DSH profile，确认待提交写入排空及最终回执；未决恢复运行应先处理。
2. 使用官方插件命令：

```powershell
node $dshBin plugin --profile web remove dsh-session-maintenance
```

3. 关闭该 profile 的 Maintenance 生命周期接入，并从启动环境中移除 Maintenance 连接配置。通用 Launcher Hook 可保留供其他 Provider 使用。
4. 使用已确认的普通 DSH home 启动，确认插件入口已移除。Canonical 会话仍保存在 Engine；禁用投影接入不保证它们继续出现在普通 DSH home 中，不能把临时投影目录直接当作永久 home。
5. 如不再使用独立看板，停止 Engine。保留 state root 即可随时重装。

只有在另一个独立、明确确认的清理任务中，才删除 Engine state root 或旧同步插件 ledger。不要把卸载插件误当作删除历史。
