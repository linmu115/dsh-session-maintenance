# P13：Phase 1 验收与可迁移门禁

## 目标

完成第一阶段只读候选的业务矩阵、1,000 会话懒加载预算、四 worker 读取上限、便携性检查、README 和可复现实证，并在此处停止扩展。

## 修改文件

- 并发发现与串行写队列：`packages/session-domain/src/discovery.ts`
- 验收矩阵：`tests/integration/phase-1-acceptance.test.ts`
- 大目录预算：`tests/integration/phase-1-large-catalog.test.ts`
- 可迁移检查：`scripts/assert-portable.mjs`、`tests/contract/portable-package.test.ts`
- 用户入口：`README.md`
- 验收证据：`docs/validation/phase-1-validation.md`、`phase-1-progress.md`
- 脚本与 CI：`package.json`、`.github/workflows/ci.yml`

## 关键决策

- 每个 instance 的目录先按 metadata 收集，再以最多 4 个 worker 进行需要的完整 observation。
- SQLite 版本/绑定/ref/candidate 变更进入一个显式 promise write queue；仓储内部事务仍保证每次 observation 原子提交。
- catalog fingerprint 未变化时不进入 observe/normalize/object store。
- API session list 和 graph 只读 SQLite 摘要/manifest，不读取正文对象。
- portability gate 仅扫描运行时代码的机器绑定，同时对整个项目执行凭据 canary；测试夹具中的虚构 Windows 路径不被误判为运行依赖。
- CI 增加 Phase 1 专项验收和 portability gate。

## 测试与结果

- 业务矩阵覆盖 unchanged、双向前缀增长、双边增长、历史改写、单/双 rename、archive、missing 和复用 UUID。
- 1,000 会话首次扫描成功；最大 observation 并发 `<= 4`；第二次 observation 为 0。
- 第一页 sessions 和单会话 graph 查询正文对象读取为 0。
- `pnpm verify:clean`：8 个包 typecheck/build 通过，25 个测试文件、62 个测试通过。
- `pnpm test:phase1`：2 个文件、3 个测试通过。
- `pnpm assert:portable`：通过。
- 独立临时 `git clone --no-hardlinks` 后执行 `pnpm bootstrap && pnpm check`：通过，且克隆 worktree 无变化；临时目录已核对后删除。
- `git diff --check`：通过。

## 明确保留到后续阶段

- 平台 writer、apply/restore、原生镜像、冲突合并与 Dashboard 均未实现。
- 旧同步插件未卸载，正式 DSH 未安装本项目插件，真实平台会话未被修改。
