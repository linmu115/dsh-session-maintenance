# Phase 1 validation progress

## Batch A — Foundation and domain

状态：完成。

| 任务 | 提交 | 结果 |
| --- | --- | --- |
| P1 独立工作区 | `27d8b22` | bootstrap 可重复；第二次运行不改变 lockfile；1 个契约测试通过 |
| P2 共享契约 | `ff9139e` | 严格 Zod 边界、DTO/计划/作业往返；全仓 4 个测试通过 |
| P3 规范化/hash | `d7a397f` | 观察噪声隔离、正文/元数据 hash 分离；全仓 9 个测试通过 |
| P4 版本图/差异 | `feat: classify session version relationships` | DAG、merge-base、快进/分叉、正文与元数据矩阵通过 |

### 批次结束门禁

- `pnpm check`：通过；2 个包 typecheck/build 通过，5 个测试文件、16 个测试通过。
- `git diff --check`：通过。
- 分支：`codex/phase-1-readonly-core`。
- 平台写入：0；本批次未创建适配器、数据库、HTTP 服务或平台运行代码。
- 设计边界：contracts 是唯一 DTO 来源，session-domain 仅包含确定性纯领域逻辑。

下一批次开始前只加载总计划、已确认规格、批次 B 计划和实际涉及源码。

## Batch B — Store and read adapters

状态：完成。

| 任务 | 提交 | 结果 |
| --- | --- | --- |
| P5 SQLite/Zstd 存储 | `cf34767` | 对象去重/校验、migration、重开、可达性和 GC dry-run 通过 |
| P6 不可变计划 | `7b87999` | 确定性 ID/hash、计划矩阵、`PLAN_STALE` 和持久化通过 |
| P7 Fixture sandbox | `787ac4f` | 真实 home/junction 拒绝，两平台合成 home 字节确定 |
| P8 Codex 只读适配器 | `69b9e99` | `0.146.0` 契约、100 会话零正文列表和稳定读取通过 |
| P9 DSH 只读适配器 | `feat: scan official DSH sessions read-only` | `0.1.1-rc.2` 多帧、100 header 惰性列表和零写入通过 |

### 批次结束门禁

- `pnpm check`：通过；6 个包 typecheck/build 通过，14 个测试文件、45 个测试通过。
- `git diff --check`：通过。
- SQLite/Zstd：重开、并发对象去重、损坏拒绝、schema 拒绝、计划重开和 GC dry-run 已验证。
- Fixture：仅在带 marker 的 Windows 临时目录运行；真实 home、缺失/linked marker 和越界 junction 被拒绝。
- Codex：100 会话列表完整 rollout 读取为 0；只观察目标会话时读取 1 个 rollout。
- DSH：100 会话列表只解压 100 个 header frame、完整 artifact 读取为 0；只观察目标会话时完整读取 1 个 artifact。
- 平台写入：0；正常 DSH 适配器验收前后 fixture tree hash 相同。

下一批次开始前只加载总计划、已确认规格、批次 C 计划和实际涉及源码。
