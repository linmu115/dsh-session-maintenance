# P16：验证后推进 Codex → DSH 安全快进

## 结果

完成路线 A 的 P16 窄写链。Engine 在平台写入前先拒绝 review/destructive、非 Codex → DSH、重复 operation 和形状不一致的计划；P14 事务完成后，再经只读 DSH Adapter 做稳定读取与语义核对，最后才原子推进 Maintenance 引用。

## 写入与引用边界

- `validateExecutableDshPlan` 只允许 create、strict-prefix append、单边 title/archive 和 no-op 组合；分叉、重写、元数据冲突及删除候选在第一笔 host mutation 前失败。
- `WriteService` 只从 immutable source version/object store 读取正文，不把正文复制进 plan 或 transaction row。
- P14 返回 `completed` 后，目标必须通过只读 Adapter 的 `observe → verify → normalize`；目标在两次读取间变化或对话语义不等于 source 时不移动任何 ref。DSH 自身的 turn/step/title envelope 会被 normalizer 保留为 metadata，但不被误判成新增对话内容。
- 目标验证版本先写入内容寻址 object store，再由 `advanceVerifiedRefs` 在一笔 `BEGIN IMMEDIATE` 事务内推进 DSH observed head、Codex/DSH 两侧 `lastCommonVersionId`、logical canonical、title 与 archive。
- 原子推进同时核对 source/target 旧 head；并发漂移返回 `PLAN_STALE`。同一 completed transaction 再次 apply 可重复验证，但不会再次写 DSH，也不会重复创建版本。
- Core no-op 不再调用 runtime reconcile，真正保持零平台 mutation。

## Engine 入口

`SessionMaintenanceEngine` 实现 WriteEngine，但写能力必须显式注入 `WriteService`。现有只读 composition 未附着 Core gateway 时继续失败关闭；本任务没有把深 Core 能力暴露给浏览器，也没有加入 EAC 或进程生命周期适配。

Checkpoint 建立和显式 transaction restore 继续委托 P14；“从 checkpoint 创建新 DSH 分支计划”仍返回明确的 `CAPABILITY_NOT_AVAILABLE`，留给后续 checkpoint 分支业务，不在安全快进门禁中伪装成就地 reset。

## 精简端到端门禁

合成 fixture 覆盖一条 strict-prefix append，并同时更新 title/archive：

1. Core host 完成 DSH mutation；
2. 只读 Adapter 接口观察并稳定复核目标；
3. DSH head、两侧 last-common 和 canonical 指向同一个 verified version；
4. 重复 apply 返回同一 `tx-p16`，host write trace 不增加；
5. 双边分叉计划被门禁拒绝，host write trace 保持不变。

## 验证

- P16 planner + integration：2 个文件、3 个测试通过。
- Core、Adapter、P14 transaction 与 P16 聚焦批次：12 个文件、26 个测试通过。
- Phase 1 回归：2 个文件、3 个测试通过（含 100-session lazy catalog）。
- 全 workspace typecheck：通过。
- 全 workspace build：通过；Core source/artifact materialization gate 继续通过。
- portability gate：194 个文本文件通过。
- `git diff --check`：通过。

## 数据安全

所有平台 mutation 只发生在内存合成 Core host 与随机临时 Maintenance root。没有读取、修改、安装或启动正式 Codex/DSH home。
