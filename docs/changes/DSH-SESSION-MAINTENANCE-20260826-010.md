# P10：幂等会话发现与匹配候选

## 目标

把 Codex 与官方 DSH 的只读目录观察转换为可追溯的逻辑会话、平台绑定、不可变版本和显式匹配候选，同时保证重复扫描不制造重复节点，也不移动 canonical ref。

## 修改文件

- 发现领域服务：`packages/session-domain/src/discovery.ts`
- 领域导出与确定性 ID：`packages/session-domain/src/index.ts`
- SQLite 完整仓储接口：`packages/session-store/src/repository.ts`
- 确定性身份测试：`packages/session-domain/test/discovery.test.ts`
- 双平台集成夹具：`tests/integration/helpers/read-only-system.ts`
- 幂等与身份冲突测试：`tests/integration/discovery-idempotence.test.ts`、`discovery-conflicts.test.ts`

## 关键决策

- 逻辑会话、平台绑定、版本和候选 ID 均只由规范化身份内容生成，不含当前时间。
- 目录摘要生成 catalog fingerprint；完全相同的第二次扫描不会读取完整正文，也不会写入仓储。
- 首次观察生成零父版本；内容或元数据变化时，以旧 observed head 作为唯一父版本。
- 同一平台 key 的首个语义事件被替换时返回 `IDENTITY_CONFLICT`，禁止把复用 UUID 误判成原会话增量。
- 标题相同只生成低置信候选；正文前缀兼容且稳定 workspace 相同只生成高置信候选，仍需人工确认。
- 只有显式跨平台 provenance 且正文兼容时才允许复用既有逻辑会话；不会按标题自动绑定。
- 正文对象先写内容寻址对象库，随后逻辑会话、版本、父边、绑定、observed ref 和候选在一个 SQLite 事务中提交。
- 扫描永远返回 `platformWrites: 0`，也不会设置或移动 canonical ref。

## 测试与结果

- 红测首先因 `DiscoveryService` 和确定性 ID 缺失产生 5 个预期失败。
- `pnpm vitest run packages/session-domain/test/discovery.test.ts tests/integration/discovery-idempotence.test.ts tests/integration/discovery-conflicts.test.ts`：3 个文件、5 个测试通过。
- 两个平台首次扫描生成 2 个逻辑会话、2 个绑定和 2 个版本；第二次扫描所有 created 计数均为 0。
- 标题变化只生成一个带单父边的新版本；相同标题只产生 1 个低置信候选。
- 复用 Codex UUID 并替换根提问时被 `IDENTITY_CONFLICT` 阻断。
- 两个平台 fixture 在两次扫描前后树 SHA-256 完全一致；所有 canonical ref 仍为空。
- `pnpm check`：6 个包 typecheck/build 通过，17 个测试文件、50 个测试通过。
- `git diff --check`：通过。

## 后续边界

- P10 仍按顺序扫描；P13 才加入有界并发工作池和大目录预算验收。
- 匹配候选只记录建议，不在第一阶段提供接受、合并或写回操作。
