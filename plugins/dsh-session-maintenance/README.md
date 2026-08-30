# DSH Session Maintenance

这是 DeepSeek Harness 的会话维护入口。当前测试基线是官方 `0.1.1-rc.2`，但安装元数据不限制 DSH 版本。它把会话右键菜单和 DSH 原生设置页接到独立的 Session Maintenance Engine；版本图、差异、同步计划、Checkpoint 和恢复仍由独立看板完成。

## 使用前准备

- DSH `web` profile；当前回归测试基线为官方 `0.1.1-rc.2`；
- 已安装并启动本项目打包的 Maintenance Engine；
- 使用本项目的可信安装器登记 Engine 连接。安装器只给 DSH host 一个连接描述符位置，浏览器不会读取 Engine capability；
- `dsh-better-sidebar` 是可选增强，不安装也能使用全部核心入口。

## 安装

使用本项目生成的插件 tgz，向目标官方 profile 添加 `dsh-session-maintenance`，再应用随包提供的 `cordis.patch.yml` 并重启该 profile。不要手工把 Engine token 写进插件设置；Engine 每次重启都会轮换 token，插件 host 会重新读取受 ACL 保护的连接描述符。

安装完成后，会话列表右键出现维护操作，DSH“设置”左栏新增“会话维护”页面。该页面可修改维护参数、扫描或同步会话，并打开完整看板；不再向聊天页面添加右下角悬浮按钮。若已安装 `dsh-resource-management`，仍可从“插件管理 → dsh-session-maintenance → 参数设置”使用精简操作面板。插件安装不做版本拒绝；若会话列表的私有 UI 结构不兼容，右键功能会安全停用，但官方设置页仍可使用。

## 日常使用

1. 首次使用进入“设置 → 会话维护”，先执行“扫描已登记会话”。
2. 右键会话可打开版本图、比较 Codex、建立 Checkpoint 或生成同步计划。
3. 只有无需确认的安全计划能从入口提交；需要复核的计划会留在独立看板。
4. “删除”仅打开候选说明，阶段二不会从右键菜单直接删除平台会话。
5. 设置页只保存实例 ID、映射 ID 和同步策略；DSH/Codex 根目录仍由可信安装器或 CLI 登记。

完整看板默认由 Engine 绑定在 `127.0.0.1`，入口带有短期一次性授权，因此不要手工记忆端口或直接收藏地址；从“设置 → 会话维护”、会话右键菜单或 Plugin Manager 的“打开会话维护看板”进入即可。

## 更新与卸载

更新前先在独立看板建立 Checkpoint，然后通过项目安装器替换插件包。卸载只移除 DSH 入口，不删除 Engine 数据库、对象、平台会话或旧插件数据。

详细部署、恢复与验收记录见项目根目录的 `docs/deployment/` 和 `docs/validation/`。
