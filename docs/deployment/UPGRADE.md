# 升级

1. 在当前看板建立命名 Checkpoint，并确认没有 `applying`、`verifying` 或 `manual-review` 事务。
2. 校验新 release manifest 与两个 tgz 的 SHA-256，阅读对应修改报告。
3. 保留旧 Engine 目录和旧插件 tgz；不要覆盖它们。
4. 停止 Engine 与目标 DSH profile。
5. 将新 Engine 解压到新的版本目录，用同一个 state root 启动；先确认 Dashboard 和 health 正常。
6. 使用官方命令更新插件：

```powershell
node $dshBin plugin --profile web add "<新版本tgz>"
```

7. 保持 `DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY` 指向同一个 state root 的 `connection.json`，重启官方 DSH。
8. 验证 loader、会话可见性、扫描、计划预览、Dashboard 与 Core probe。

若新版本的 DSH/client/Core 契约不匹配，系统会失败关闭；不要通过修改 fingerprint 或关闭校验强行启动。按 `RECOVERY.md` 恢复旧包。

升级插件不会自动建立 Generation、覆盖平台会话或删除旧同步数据。
