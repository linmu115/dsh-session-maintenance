# 启动前恢复未收尾运行

范围仅为 Maintenance 的外部生命周期 Provider 与共享协议。引用、贴纸、思维图、BetterSidebar、看板 UI 和业务 Adapter 未修改。

## 行为

- `recoverBeforeStart` 按实例 ID 与 profile 只读查询正式运行记录，使用原 handle 的 owner 调用 Broker 恢复；`prepare` 内也执行检查，兼容旧 Launcher。
- 电脑本次启动时间晚于旧运行及 handle 创建时间至少一分钟时，可确认旧运行不能存活。系统时间无法解析、时间边界不清楚或查询失败时拒绝自动恢复。
- `started` 保存 PID、进程创建时间和系统启动时间。PID 相同且创建时间相同的进程仍在时拒绝恢复。
- Launcher 已确认进程树退出后发出的 `afterExit`，先持久保存退出证据，再发起收尾。接口失败保留凭据，下次启动重试。
- Broker 回执必须同时为 `closed/recovered` 且确认投影清理。仅返回成功 HTTP 或清理标志不够。
- 丢失响应但正式数据库已提交终态时，只补齐 handle 回执，不重复恢复数据。正式终态由现有 Lifecycle 在清理之后提交。
- 正常运行记录、所有权与历史数据不通过直接 SQL 修改；元数据只读，所有恢复写入仍走正式 Broker。

## 边界

同一次系统启动内，如果 Launcher 崩溃且没有收到进程树退出证明，即便根 PID 已不存在，也不会假定全部子进程已结束。此时保留明确提示；正常退出旧实例，或系统重启后可再自动处理。非 Windows 平台暂不提供操作系统退出证据探测。

新增两个可选 Provider 阶段保持 schema v1。新 Launcher 通过独立的 `runtime-lifecycle.startup-recovery.json` 开关启用，不改变旧 `runtime-lifecycle.json` 的结构；旧 Provider 默认不会接收新阶段。

## 验证

- 新增 12 项定向测试通过，覆盖旧系统启动遗留、活跃进程、PID 复用、未知退出、失败后重试、丢失响应、错误回执、实例/profile 隔离、只读查询和真实 Windows 身份探测。
- Engine TypeScript 检查通过。
- 原 Provider 测试 9 项通过、3 项 Alpha2 适配器探测失败；在未修改的 `cd64472` Provider 基线上复测同样 3 项失败。本次未修改适配器来掩盖原问题。
- `package-startup-recovery.mjs` 从已安装发行目录派生，仅替换 Engine 入口及构建元数据，校验其他文件 SHA256 相同。版本保持已有兼容组合，`localPatch` 与 sourceCommit 标识此次本地修订。
- 真实旧运行经备份后于 2026-09-19 正式恢复，状态 `finalized`、回执 `recovered`；Status 不再发现活跃 run。真实 Launcher 恢复提示尚未做视觉验收。

备份与安装证据位于 `D:/AI/DeepSeekHarness-Plugin/artifacts/startup-recovery-20260919`。安装状态以该目录实际回执为准，不以源码完成代替已激活。
