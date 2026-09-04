# T10 Alpha2 投影启动主链变更报告

## 范围

- 新增 `@linmu/dsh-session-projection-lifecycle`，实现 `openRun` 的租约、完整物化、摘要核验和 Runtime attach 主链。
- 新增 Alpha2 Runtime Bridge 与 DSH 插件侧 projection runtime registrar/overlay。
- Engine 组合根登记投影运行仓库、规范投影源和独立 runtime root，并提供受认证的 run-scoped runtime snapshot 路由。
- Engine 启动自动登记内置 Alpha2 Adapter 及其隔离 probe worker，满足 projection run 外键并允许真实能力选择。
- Profile 配置边界只允许 `runId + loopback Maintenance endpoint`；投影目录不进入插件参数，也不进入 Launcher Profile。

## 固定状态断点

一次成功 `openRun` 持久记录：

```text
run.lease:started
run.lease:succeeded
projection.materialize:started
projection.materialize:succeeded
runtime.persistence.attach:started
runtime.persistence.attach:succeeded
```

第二个同 branch writer 先以非活动 `quarantined` 候选登记，再在状态转换时命中唯一活动 writer 约束，记录 `run.lease:failed / LEASE_HELD`。这样失败运行也有可查询日志，同时不会占用写租约。

## 数据与路径边界

- 完整读取所有未墓碑会话及未删除逻辑工作区；空工作区也进入 manifest 数量和摘要。
- 投影只写入 Maintenance `projection-runtime/runs/<runId>/projection` 下的 run-scoped 目录。
- Engine runtime API 按 runId 返回投影快照，不向 DSH 暴露文件路径。
- Runtime Bridge 向 DSH registrar 仅传 runId 和 endpoint；认证能力由可信 transport/provider 单独注入，不进入 descriptor 或状态日志。
- P2/P3 失败时保留投影恢复材料并把运行置为 `quarantined`；P3 已 attach 后若状态切换失败，会主动 detach。

## Alpha2 破坏性变化处理

- 继续使用 Alpha2 format-version-0 SessionHeader 与连续 event seq。
- Runtime 接入围绕 `sessionPersistence` 投影 overlay，不引用已删除 Client Runtime。
- 插件读取的是 Engine 已物化并核验的 Alpha2 DTO，不直接读取 Maintenance 数据库，也不写 Profile 永久 sessions 目录。

## 聚焦验证

```text
pnpm exec vitest run packages/projection-lifecycle/test/open-run.test.ts packages/adapter-dsh-alpha2/test/runtime-bridge.test.ts plugins/dsh-session-maintenance/test/projection-runtime.test.ts tests/integration/alpha2-projection-open.test.ts
```

最终包含 Core Smoke 与 Engine Registry 回归在内共 6 个测试文件、7 个测试全部通过：

- P1-P3 顺序、第二 writer 拒绝和失败日志；
- Alpha2 Bridge 不泄露 projection root；
- 插件仅接受安全 runId/loopback endpoint，并能从 overlay 列出合成会话；
- SQLite 规范源完整物化为 Alpha2，会话、工作区、事件及六条状态可读取；
- Engine 启动后内置 Alpha2 Adapter 以 Generation 来源出现在 Registry；
- Launcher Profile 的 `sessions` 目录没有创建或写入。

四个相关包的 TypeScript 检查以及 `git diff --check` 均通过。遵循高效断点策略，未运行全仓测试，也未接触真实 Codex/DSH Home。
