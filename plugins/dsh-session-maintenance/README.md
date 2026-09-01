# DSH Session Maintenance

这是 DeepSeek Harness 的稳定会话入口。Maintenance 保存与 DSH 版本无关的规范会话和逻辑工作区；Launcher 启动 Alpha2 或 RC2 时，把同一真源转换为该版本认识的临时投影，正常关闭后清空实例内的会话文件。

## 当前能力

- Maintenance 是 DSH 会话真源；Codex 仍维护自己的独立真源，Maintenance 只增量观察，不改写 Codex 日志。
- 只读打开 Codex 镜像不会产生分支；第一次从 DSH 续写时只派生一个 Maintenance 会话。
- Alpha2 与 RC2 Profile 使用同一逻辑工作区和会话目录，原生 session ID 仅作为当前投影映射。
- Annotation、Sticker 与 Obsidian 链接保存 `logicalSessionId` / `logicalAnchorId`，并保留旧 native ID 作为历史别名。
- 删除和恢复只能从 Maintenance WebUI 执行；删除前建立 Checkpoint，实例侧不会把本地删除误当成全局删除。
- P1-P8 状态入口覆盖租约、物化、持久化接管、增量提交、延迟派生、跨版本校验、引用回环和退出恢复。

## Launcher 配置

在目标 Profile 中选择：

- 会话来源：`Session Maintenance`
- Maintenance 端点：`auto`
- Alpha2 固定 Adapter：`dsh-alpha2`
- RC2 固定 Adapter：`dsh-rc2`

Profile 不保存真实会话目录。启动时 Launcher 发现或唤醒 Engine，并通过一次性进程环境传递运行参数；正常关闭会等待 pending write 排空，异常退出保留恢复清单。

## WebUI

从 Launcher 或 DSH“设置 → 会话维护”打开独立 WebUI。左侧显示逻辑工作区树，右侧静态读取规范事件，并提供谱系、Checkpoint、最近删除、恢复、运行中心和 Adapter 状态。DSH 不运行时仍可查阅会话。

## 版本策略

插件 peer 范围保持开放，不因实验版 semver 阻止组合。具体 DSH 格式由公开 Adapter SDK 处理；首批内置 Adapter 为官方 `0.1.2-alpha.2` 与 `0.1.1-rc.2`。第三方适配指南见 Generation 的 `documentation/adapters/`。

更新前请建立 Checkpoint。回滚时可恢复上一 Generation，并把 Engine 配置中的数据库指针切回封存的 `metadata.sqlite`。卸载 DSH 入口不会删除 Maintenance 数据库或 Codex 真源。
