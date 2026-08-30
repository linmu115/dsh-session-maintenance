# DSH Session Maintenance 2026-08-30 Change 047

## 目标

让 DSH 官方 profile 在被任意壳、终端或进程管理器重新启动后，仍能稳定连接本机 Session Maintenance Engine，不再强依赖启动进程保留自定义环境变量。

## 现象与原因

`dsh-session-maintenance@0.1.4` 已成功注册到 DSH 官方 `settings.section`，但现场冷启动验收发现：当 DSH 被另一入口重新拉起且该入口没有传递 `DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY` 时，设置页会显示“维护引擎连接尚未由可信安装器登记”。Engine 本身仍在线，连接描述符也仍位于安装器约定的当前用户状态目录；缺失的是启动进程到插件之间的路径提示。

## 修改

- 显式的 `DSH_SESSION_MAINTENANCE_CONNECTION_<ID>` 仍具有最高优先级。
- 对安装器保留的 `primary` 连接增加固定回落：`%LOCALAPPDATA%/DSH-Session-Maintenance/connection.json`。
- 非 `primary` 连接不猜测路径，仍要求显式可信登记。
- 插件版本更新为 `0.1.5`。

## 安全边界

- 回落路径不是插件参数或网页输入，网页不能指定文件路径。
- 连接描述符仍由本机安装器生成，仍须通过原有 schema、loopback host、端口和 capability 格式校验。
- 没有把 token、origin 或文件系统路径暴露给 DSH 客户端。
- 没有加入 EAC 或特定外壳兼容逻辑；这是官方 DSH profile 与独立 Engine 的通用本机连接规则。

## 验证

- 单元测试覆盖显式登记优先、`primary` 固定回落以及非 `primary` 拒绝猜测。
- `pnpm --filter dsh-session-maintenance typecheck`：通过。
- `pnpm --filter dsh-session-maintenance test`：8 个测试文件、19 项测试通过。
- `pnpm --filter dsh-session-maintenance build`：通过。
- `git diff --check`：通过。
- Maintenance 依赖预览只包含目标插件，`transitive=0`、`unrelated=0`、无兼容性警告。
- 正式 `web` profile 已部署 `0.1.5` 并完成冷启动，DSH stderr 为空。
- DSH 官方“设置 → 会话维护”可以读取 Engine 参数，页面显示“维护参数已读取”。
- 浏览器验收确认旧 `.dsm-entry-launch` 悬浮入口数量为 0。

## 回退

回退到 `dsh-session-maintenance@0.1.4` 会恢复“只接受环境变量路径”的行为，不影响 Engine 状态、会话数据或 Generation。
