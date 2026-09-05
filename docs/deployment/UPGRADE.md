# 升级

Engine、Dashboard、DSH 插件、Adapter、SCM 和 Launcher Hook 的版本关系应写入同一发布记录；只有实际构建和验收过的组合才标为已验证。当前运行基线和候选看板修复见 [README](../../README.md)。本说明不表示已经切换真实运行。

1. 阅读候选修改说明，校验 manifest 与产物 SHA-256，记录来源提交、各包版本、Launcher 修订及未提交补丁状态。保留旧的完整构建、插件包与 profile package/lock/bundle 配置。
2. 在当前 Engine 仍运行时正常停止 DSH，让插件与 Provider 排空待提交写入。确认最终回执和运行状态；仍有活动写入或未排空操作时不要切换。历史隔离运行的正文、WAL 和引用应纳入受保护恢复点，确认候选版本能继续读取其恢复格式；如果兼容性或现场完整性无法确认，先解决这一具体问题。
3. 然后停止 Engine，在稳定状态下备份实际数据库、正文对象及运行/恢复证据。Checkpoint 是版本引用，不是整个状态目录的备份。
4. 将新 Engine 解压到新目录；检查 schema 兼容性后，使用同一个 state root 启动。数据库已迁移时不能直接交给仅支持旧 schema 的二进制。
5. 使用官方插件命令更新匹配 profile，并更新宿主配置中的 Engine 路径。只有宿主已实现匹配 Hook 时配置才有效。

```powershell
node $dshBin plugin --profile web add "<新版本插件tgz>"
```

6. 验证健康接口、看板认证跳转、HTML/应用脚本、未授权 API 拒绝；再启动 DSH，验证会话身份、来源/派生、追加回执、空会话及正常停止恢复。新版本的协议或 Adapter 探测失败时，不改 fingerprint 或关闭校验绕过。

`a6b4053` 的 Dashboard 目录发现补丁不引入数据库迁移，可在安全停止后切换完整构建；它的自动化测试与 CLI 验证不替代真实插件入口验收。后续含 schema 迁移的版本按各自说明处理。回退见 [RECOVERY](RECOVERY.md)。
