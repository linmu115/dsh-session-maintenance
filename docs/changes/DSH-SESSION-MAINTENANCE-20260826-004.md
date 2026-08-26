# P4：版本图与会话差异分类

## 目标

实现经过校验的不可变版本 DAG 查询和不合并正文的 reconciliation 分类，可靠区分相等、两向快进、分叉、无共同祖先、严格前缀追加、重写和元数据冲突。

## 修改文件

- 图实现：`packages/session-domain/src/graph.ts`
- 差异实现：`packages/session-domain/src/diff.ts`
- 聚合导出：`packages/session-domain/src/index.ts`
- 测试：`packages/session-domain/test/graph.test.ts`、`diff.test.ts`
- 批次证据：`docs/validation/phase-1-progress.md`

## 关键决策

- `VersionGraph` 在构造时拒绝空 ID、重复 ID、重复父节点、缺失父节点、环和超过两个父节点。
- `isAncestor()` 把节点自身视为祖先；未知版本 ID 明确失败，不返回容易被误解的 `false`。
- merge-base 选择共同祖先中总边距最短者；总边距相同时按版本 ID 词法顺序决定，结果不依赖输入顺序、时间戳或本机区域设置。
- `classifyHeads(source, target)` 的方向固定为 `source-ahead | target-ahead`，无共同祖先时为 `unrelated`，双方均非祖先但有共同祖先时为 `diverged`。
- 对话变化只有 `unchanged | append-only | rewritten`；append-only 要求基线中每个事件在相同索引深度相等。删除、重排或既有事件编辑都是重写。
- 元数据三方比较允许单边变化；双方得到完全相同结果视为已收敛，双方不同变化或分别修改不同字段均标记冲突。
- 本任务没有生成合并 transcript、两父解析版本或平台写操作。

## 测试与结果

- `pnpm vitest run packages/session-domain/test/graph.test.ts packages/session-domain/test/diff.test.ts`（实现前）：7 个测试失败，缺少图/差异导出，符合红测预期。
- 同一目标命令（实现后）：2 个文件、7 个测试全部通过。
- `pnpm --filter @linmu/dsh-session-domain typecheck`：通过。
- `pnpm check`：5 个测试文件、16 个测试全部通过，contracts/domain typecheck 和 build 通过。
- `git diff --check`：通过。

## 遗留风险

- 当前图保存在内存中；SQLite 分页加载和对象可达性由批次 B 实现。
- 元数据分类只覆盖标题与归档，这是阶段一确认的同步范围；工作区映射和钉选不会在此函数中自动合并。
