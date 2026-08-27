# Phase 4 原生镜像与正式部署收口

**日期：** 2026-08-27

**范围：** Codex 原生镜像、正式 DSH 部署、真实目录容错

## 改动

- 新增版本锁定的 Codex native write Adapter、镜像状态机、事务恢复、API 和 Dashboard 操作。
- 修正写入验证后的 ref 收敛与幂等重试。
- 将 DSH Core 扩展和入口插件正式部署到官方 `web` profile，并移除旧 `dsh-codex-session-sync`。
- 使用一个真实 Codex 延续任务验收分页读取、resume、列表和持久化。
- Codex 扫描遇到超过 64 MiB 的单条历史时改为计数并跳过，不再阻塞整个目录。
- 按真实 rollout 结构允许根元数据之后存在内嵌 lineage `session_meta`；根任务身份仍严格校验。

## 原因

真实 Codex Home 同时包含超大历史和带来源 lineage 的 rollout。两者都属于单条会话边界，不能让其余数百个正常任务失去可维护性；但也不能通过关闭大小或身份检查来规避。最终实现分别采用“明确跳过并计数”和“根身份严格、内嵌来源允许”的有限规则。

## 验证

- 66 files / 142 tests；
- 20 个工作区 typecheck/build；
- 346 个文本文件便携性检查；
- 3/3 可复现打包；
- 官方 DSH 页面、client factory、Engine、DSH read/write contract 与 loader 全部健康；
- 正式 DSH 扫描幂等；
- 正式 Codex 扫描完成：371 个会话入库、26 个超大历史跳过、0 平台写入；
- 正式总览 631 个逻辑会话、0 冲突、0 未解决事务。

## 回退

正式部署前状态位于：

`D:\AI\DeepSeek-Harness\home\profiles\web\.dsh-session-maintenance-backup\formal-phase4-20260827-2158`

恢复时应把 profile package/lock/Cordis、插件物化目录和 Engine 作为一整套恢复，不单独覆盖其中一项。
