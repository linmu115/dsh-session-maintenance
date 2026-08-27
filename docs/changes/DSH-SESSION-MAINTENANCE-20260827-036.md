# 官方 rc.2 会话存储读取契约修正

**日期：** 2026-08-27  
**范围：** `adapter-dsh`、官方 DSH 实例登记

## 发现

正式部署预检使用只读 `instance add` 探测 `D:\AI\DeepSeek-Harness\home` 时返回 `ADAPTER_INCOMPATIBLE`。官方 `0.1.1-rc.2` 的持久数据实际使用：

- `session_projcache.json`：`unit=session_projcache@3`，会话位于 `tables.sessions`，标题位于 `rows.title.val`；
- `workspace.json`：`unit=workspace@2`，归档集合位于 `global.archivedSessionIds`，工作区成员位于 `tables.workspaces[*].sessionIds`。

旧测试夹具误用了顶层 `sessions[]` 简化结构，因此未能证明正式实例可登记。

## 修正

- 读取适配器严格解析上述两个官方 domain data form，并拒绝 unit/version 漂移。
- 从 workspace 表恢复稳定工作区 ID，从全局集合恢复归档状态，从 projection row 恢复标题。
- 检测一个会话被登记到多个工作区时返回 `IDENTITY_CONFLICT`。
- 测试夹具改为官方 rc.2 真实外形，读取契约 fingerprint 同时绑定 projection/workspace domain 版本。

## 验证

- `packages/adapter-dsh/test/dsh-adapter.test.ts`：4 项通过。
- `packages/test-support/test/sandbox.test.ts`：4 项通过。
- 两个受影响包 typecheck 通过。
- 使用构建后的 Engine 对正式 DSH home 执行只读 probe，`dsh-web` 登记成功。

本修正没有修改 DSH profile package/lock/bundle，也没有移动或改写任何会话。
