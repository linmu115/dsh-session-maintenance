# T18 — DSH Launcher Profile 接入

## 结果

- Launcher Profile 可选择 `native` 或 `maintenance` 会话来源。
- Maintenance Profile 只保存端点和 Adapter 选择，不保存 DSH/Codex/Maintenance 会话路径。
- Launcher 启动时发现或唤醒 Engine，验证健康状态后通过一次性进程环境变量向插件交付运行配置。
- 插件严格解析该配置，只接受 loopback origin、受限 ID 和已知字段；远端地址、路径字段与未知字段会被拒绝。
- Engine 支持由可信 Launcher 环境选择自身 state root，但该路径不会传给 DSH Profile。
- `branchId` 仅保留数据位置，首版 UI 不开放多写者。
- Launcher Runtime 状态预留 active lease、pending count 和 WebUI 入口。

## DSH 破坏性更新隔离

Profile 不再通过原生 `sessions` 目录共享会话，也不依赖 RC2/Alpha2 的工作区 ID。版本切换只改变 Adapter 选择；同一 Maintenance endpoint 仍指向同一规范真源。

## 聚焦断点

- Plugin contract：`plugins/dsh-session-maintenance/test/launcher-profile.test.ts`，4/4 通过。
- Plugin 与 Engine typecheck：通过。
- Launcher WebUI：`pnpm build` 通过。
- Launcher Rust：`cargo check` 与 focused `--no-run` 编译通过。
- Launcher Rust 测试进程在当前 Windows GNU/Tauri 环境启动时命中既有 `STATUS_ENTRYPOINT_NOT_FOUND`，故未把“无法启动测试宿主”误报为 Maintenance 业务断点失败；未扩大测试范围。

## 数据安全

本任务没有读取或写入真实 DSH、Codex、Obsidian、Launcher Profile 会话目录。测试只使用内存值和编译期夹具。

