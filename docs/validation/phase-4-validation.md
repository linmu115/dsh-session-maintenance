# Phase 4 验收记录：Codex 原生镜像

**日期：** 2026-08-27

**分支：** `codex/phase-4-native-mirror`

**支持契约：** Codex `0.146.0` / DSH `0.1.1-rc.2`

## 结论

Phase 4 工程闭环完成。少量重要会话可以逐会话显式启用原生镜像；普通会话默认仍走 continuation。Codex 写入使用版本和 schema allowlist、静默检测、完整备份、候选区校验、事务发布、普通 reader 复验及逆序恢复。未知版本、schema 漂移、Codex 忙碌、空间不足或未完成恢复任一条件出现时均零写入。

## 已实现能力

- `adapter-codex-native`：当前版本指纹、备份清单、候选写入、发布、验证和恢复；
- DSH/Codex 共用 `PlatformWriteAdapter` 事务编排，平台格式仍封装在各自 Adapter；
- 普通消息原生映射，工具/推理/不可等价事件降格为带 provenance 的 DSH 导入记录；
- 镜像状态机：`disabled → initializing → active → paused/busy/incompatible/conflicted → recovering`；
- Engine API 与 Dashboard：启用、暂停、恢复、保持双分支、选择规范主线、双父延续与事务预览；
- 验证成功后同时推进来源 ref、目标 ref 与共同版本，重复重试幂等；
- 归档和单边元数据可安全同步，删除不自动传播。

## 自动验收

- 原生镜像端到端：启用镜像 → DSH 追加 → Codex 事务写入 → 普通 Codex reader 复验 → 两侧 ref 收敛 → 镜像恢复 active；
- 故障矩阵覆盖预检、备份、候选、验证、发布与恢复；
- 未知 Codex 版本、schema 漂移和 busy 状态均证明零写入；
- 全量 typecheck/build 通过；
- 66 个测试文件、142 项测试全部通过；
- 346 个文本文件通过便携性检查；
- Engine 与插件连续三次打包一致。

## 真实环境验收

- Codex read contract：`compatible`；
- Codex native write contract：识别为 `0.146.0`，但由于 Codex Desktop 正在运行，状态为 `degraded/CODEX_BUSY`，write capabilities 为空，没有写入真实 Codex Home；
- 当前没有用户显式启用的真实 mirror，`MirrorCount=0`；
- 正式 Codex 扫描首次导入 371 个逻辑会话、371 个绑定和 372 个版本，平台写入 0；
- 26 个超过 64 MiB 的历史被明确计数并单独跳过；
- 第二次扫描没有重复创建会话或绑定，只为正在变化的当前 Codex 任务产生 1 个新版本；
- 正式总览：631 个逻辑会话、0 冲突、0 未解决事务。

真实 rollout 还验证了 Codex 可在根 `session_meta` 后保存内嵌来源会话元数据。Reader 现在只用首条根元数据确认外层任务身份；后续 lineage 元数据可保留，但根 ID不匹配仍以 `IDENTITY_CONFLICT` 拒绝。

## 暂不开放

显式重置和删除需要平台提供可证明恢复的目标契约。当前 API 会返回不可用，不展示伪成功，也不会直接改写正式历史。真实原生镜像写入还要求用户先完全关闭 Codex，再对明确选中的重要会话启用。
