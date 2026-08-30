# DSH Session Maintenance 2026-08-30 Change 046

## 目标

将 `dsh-session-maintenance` 的全局入口从聊天页面右下角悬浮按钮迁入 DSH 官方设置系统，同时保持独立 Engine、Dashboard、会话右键菜单和 Plugin Manager 操作契约不变。

## 原因

旧入口通过 `document.body.appendChild()` 创建固定定位按钮和自有遮罩面板。它会长期占用聊天页面空间，也把全局参数与单会话操作混在同一个非原生入口中。DSH 从 `0.1.1-rc.2` 起提供正式的 `settings.section` 槽位；当前正式 profile 使用的 `0.1.2-alpha.1` 继续保留相同契约。

## 修改

- 插件版本更新为 `0.1.4`。
- 客户端声明并注入官方 `slots` 与 `ui-settings` 依赖，通过 `settings.section` 注册“会话维护”页面。
- 将实例 ID、工作区映射、同步策略、备份保留数和直接操作迁入原生设置页面。
- 删除右下角悬浮按钮、私有遮罩面板及对应样式。
- 会话右键菜单继续提供会话级操作，但不再重复提供全局参数面板。
- 设置页注册与会话列表私有 DOM 契约解耦：即使未来会话行结构漂移导致右键入口安全停用，官方设置页仍会加载。
- 客户端只从 DSH 平台模块表加载 `react` 与 `react/jsx-runtime`，不在插件内打包第二份 React。
- README 改为“设置 → 会话维护”的使用路径。

## 边界

- 没有修改 Engine API、数据库、授权票据、会话数据或 Codex/DSH Adapter。
- 完整 Dashboard 仍使用 Engine 签发的一次性本机链接在独立页面打开；设置页只承担参数、直接操作和短反馈。
- `dsh-resource-management` 的参数面板及 `dsh-better-sidebar` 可选入口保持兼容。

## 验证

- `pnpm --filter dsh-session-maintenance typecheck`：通过。
- `pnpm --filter dsh-session-maintenance test`：8 个测试文件、17 项测试通过。
- `pnpm --filter dsh-session-maintenance build`：通过。
- 客户端产物只保留 `require("react")` 与 `require("react/jsx-runtime")` 平台外部引用。
- 客户端产物中不存在 `dsm-entry-launch` 或 `dsm-entry-backdrop`。

## 回退

回退到 `dsh-session-maintenance@0.1.3` 会恢复右下角入口；Engine 状态和会话数据无需迁移或回退。
