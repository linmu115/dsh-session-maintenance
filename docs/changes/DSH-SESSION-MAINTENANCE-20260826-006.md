# P6：不可变 Dry-run 计划

## 目标

根据已规范化的基线、来源端和目标端生成确定性同步计划，持久化精确 JSON，并在平台指纹改变时以 `PLAN_STALE` 拒绝继续。

## 修改文件

- 领域计划器：`packages/session-domain/src/planner.ts`、`src/index.ts`
- 计划 fixture/测试：`packages/session-domain/test/plan-fixtures.ts`、`planner.test.ts`
- 计划持久化：`packages/session-store/src/repository.ts`
- 持久化测试：`packages/session-store/test/plan-store.test.ts`

## 关键决策

- 计划方向明确为来源端到目标端：来源严格包含目标前缀时生成 `append-events`；目标已经领先来源时生成安全空计划，不反向覆盖。
- 相等正文只处理允许的单边标题/归档变化；双边不同变化只生成 `require-review: METADATA_CONFLICT`。
- 双方从共同基线独立追加生成 `DIVERGED`；既有事件编辑/删除/重排生成 `REWRITTEN`；身份冲突优先生成 `IDENTITY_CONFLICT`。
- 曾观察到的目标消失生成 destructive `deletion-candidate`；从未存在的目标生成 `create-target-session`。两者在本阶段都只是计划记录。
- 计划内容先进行字段白名单 canonicalization；`hash` 为完整 SHA-256，`id` 为其 24 位前缀。`createdAt` 由调用方显式提供，因此相同输入产生相同计划。
- 前置条件按完整平台会话键、fingerprint kind 和 value 组成集合；顺序无关，但缺失、额外、重复或值变化都会返回 `PLAN_STALE`。
- `savePlan()` 同时验证 schema 和内容身份；同一计划可幂等重试，同 ID/hash 不同 JSON 返回 `VERSION_ID_COLLISION`。
- `getPlan()` 对 JSON、Zod schema、表列身份和重新计算的 ID/hash 做完整验证，损坏返回 `OBJECT_CORRUPT`。

## 测试与结果

- P6 目标命令（实现前）：9 个测试失败，缺少 planner/仓储方法，符合红测预期。
- `pnpm vitest run packages/session-domain/test/planner.test.ts packages/session-store/test/plan-store.test.ts`：2 个文件、9 个测试通过。
- contracts/domain/store typecheck：通过。
- `pnpm check`：9 个测试文件、29 个测试全部通过，3 个包 typecheck/build 通过。
- `git diff --check`：通过。

## 遗留风险

- 本阶段没有 `applyPlan`；所有操作均为不可变 dry-run 记录。
- 新目标的创建计划目前只记录创建动作；平台写适配器在后续阶段按目标能力决定如何携带会话内容。
