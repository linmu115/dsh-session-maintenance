# 正式 `web` profile 替换预览（尚未执行）

**生成日期：** 2026-08-27  
**状态：** 只读预览；等待用户明确批准，不代表已安装或卸载。

## 当前正式环境

- DSH 安装：`D:\AI\DeepSeek-Harness`
- DSH home：`D:\AI\DeepSeek-Harness\home`
- profile：`web`
- 官方 runtime：`0.1.1-rc.2`
- DSH origin：`http://127.0.0.1:3080`
- 当前旧同步包：`dsh-codex-session-sync@0.3.3`，仍同时存在于 profile 顶层 dependencies、`dsh.profile.bundles` 与 `node_modules`。

## 拟议新基线

- 安装：`dsh-session-maintenance@0.1.0`
- Engine 实例 ID：`dsh-web`
- Engine state root：`%LOCALAPPDATA%\DSH-Session-Maintenance`
- Core gateway：`dsh-web=http://127.0.0.1:3080`
- DSH host descriptor 环境：`DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY=<state-root>\connection.json`

拟议事务先把新包加入 `dependencies` 与 `dsh.profile.bundles`，重建 lock/node_modules，重启并完成 loader、会话、菜单、扫描、计划和 Dashboard 验收。只有新基线全部通过后，才从 dependencies 与 bundles 移除 `dsh-codex-session-sync`。

## 备份与回退

正式事务开始前需保存：

- profile `package.json`；
- `pnpm-lock.yaml`；
- `pnpm-workspace.yaml`；
- 旧同步插件的精确 tgz/file 引用；
- 当前 bundle 顺序；
- Engine `connection.json` 只记录位置和文件 hash，不复制其中 capability 到报告。

建议备份目录：`D:\AI\DeepSeek-Harness\home\profiles\web\.dsh-session-maintenance-backup\<transaction-id>`。失败时按整个 package/lock/bundle 组合恢复，并验证官方 DSH 再次启动。

## 明确不做

- 本预览没有修改正式 profile、lockfile、node_modules、会话或进程。
- 不删除旧 ledger、旧 tgz、Engine state 或任何平台会话。
- 不保留两个同步插件长期同时启用。
