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
