# RC2 工作区归档同步

RC2 的 `WorkspaceRegistry.archiveSession` 将归档集合写入 workspace domain global，不产生 Session 事件。官方通知为 `domain/changed`，其中 `domain='workspace'`、`table=''`、`key=''`、`operation='put'`；官方 WorkspaceFeed 同样读取该通知。

Maintenance 宿主现在使用官方 `workspaceDomainState` 解码已提交事件的 `archivedSessionIds`。通知发出时 WorkspaceRegistry 的自身缓存可能仍是旧值，因此不会在通知回调里重新读取该缓存。桥只观察通知，不包装工作区方法，不修改工作区存储。

启动后重放当前已归档集合，调用 run 绑定的 `MaintenanceGraph.setSessionArchived(nativeSessionId, archived)`。以后按已提交集合的增减同步 true/false。冷启动不会扫描全部会话发送 false，也不会把缺席当作恢复指令；恢复仍以 Maintenance 真源为准。

每个会话保留顺序队列，已失败的 true 不会被后来的 false 覆盖。不同会话可以继续推进；失败采用 1–30 秒退避重试，每项失败只记录一次不含凭据的提示。插件卸载会拆除监听和重试定时器，并等待已发出的事务结束，再让 Runtime Broker drain 当前 run。未完成的已归档意图可从下一次启动的持久化工作区集合重新取得，不另造一份归档真源。

定向 8 项测试覆盖冷启动重放、失败后重启恢复、事件快照先于缓存更新、无关/非法事件过滤、失败重试、同会话 true→false 与快速 true→false→true 顺序、卸载清理和在途事务结束。最终插件 typecheck 与 build 通过。此前完整插件检查的归档桥及其余功能测试均通过；唯一旧版本断言在主任务统一更新后，与归档桥一起复测为 2 文件、9 项测试全部通过。

本子任务不修改版本，不提交，不进行真实 profile、Engine 或 Vault 部署。
