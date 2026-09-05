# DSH Session Maintenance

这是 DeepSeek Harness 的稳定会话入口。Maintenance 保存与 DSH 版本无关的规范会话和逻辑工作区；Launcher 启动 Alpha2、RC1 或 RC2 时，把同一真源转换为该版本认识的临时投影，正常关闭后清空实例内的会话文件。

## 当前能力

- Maintenance 是 DSH 会话真源；Codex 仍维护自己的独立真源，Maintenance 只增量观察，不改写 Codex 日志。
- 只读打开 Codex 镜像不会产生分支；第一次从 DSH 续写时只派生一个 Maintenance 会话。
- Alpha2 与 RC2 Profile 使用同一逻辑工作区和会话目录，原生 session ID 仅作为当前投影映射。
- Annotation、Sticker 与 Obsidian 链接保存 `logicalSessionId` / `logicalAnchorId`，并保留旧 native ID 作为历史别名。
- 删除由 Maintenance WebUI 或授权的 SCM 右键入口请求，统一在 Engine 真源执行；
  沿用删除前 Checkpoint、墓碑与恢复策略。普通实例归档仍不视为全局删除。
- P1-P8 状态入口覆盖租约、物化、持久化接管、增量提交、延迟派生、跨版本校验、引用回环和退出恢复。

## Launcher 配置

0.2.16 修复 RC1 空会话头的惰性持久化，并增加按当前投影运行定位的直接删除入口。
需配合 Engine 0.1.14 重载；不要求重建 Canonical/Codex 镜像或更改模型配置。
详细断点及验收见仓库 `docs/changes/RC1-SCM-IDENTITY-AND-EMPTY-SESSION.md`。

在目标 Profile 中选择：

- 会话来源：`Session Maintenance`
- Maintenance 端点：`auto`
- Alpha2 固定 Adapter：`dsh-alpha2`
- RC1 固定 Adapter：`dsh-rc1`
- RC2 固定 Adapter：`dsh-rc2`

Profile 不保存真实会话目录。启动时 Launcher 发现或唤醒 Engine，并通过一次性进程环境传递运行参数；正常关闭会等待 pending write 排空，异常退出保留恢复清单。

## WebUI

从 Launcher 或 DSH“设置 → 会话维护”打开独立 WebUI。左侧显示逻辑工作区树，右侧静态读取规范事件，并提供谱系、Checkpoint、最近删除、恢复、运行中心和 Adapter 状态。DSH 不运行时仍可查阅会话。

## 版本策略

插件 peer 范围保持开放，不因实验版 semver 阻止组合。具体 DSH 格式由公开 Adapter SDK 处理；当前内置 Adapter 为官方 `0.1.2-alpha.2`、`0.1.2-rc.1` 与 `0.1.1-rc.2`，其中 `dsh-rc1` 只声明精确的 `0.1.2-rc.1`。第三方适配指南见 Generation 的 `documentation/adapters/`。

更新前请建立 Checkpoint。回滚时可恢复上一 Generation，并把 Engine 配置中的数据库指针切回封存的 `metadata.sqlite`。卸载 DSH 入口不会删除 Maintenance 数据库或 Codex 真源。
