# P1：初始化独立会话维护工作区

## 目标

建立与旧 `dsh-codex-session-sync`、EAC 和 Maintenance 运行时解耦的 pnpm monorepo，固定 Node/pnpm/TypeScript/Vitest 版本，提供可重复 bootstrap、Windows CI 和首个共享契约常量。

## 修改文件

- 根工作区：`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json`、`vitest.config.ts`、`.gitignore`、`AGENTS.md`
- 自动化：`scripts/bootstrap.mjs`、`.github/workflows/ci.yml`
- 契约包：`packages/contracts/package.json`、`packages/contracts/tsconfig.json`、`packages/contracts/src/index.ts`
- 测试：`tests/contract/workspace-contract.test.ts`
- 设计输入：复制已确认规格、路线图和阶段一四份计划到 `docs/superpowers/`

## 关键决策

- 目标仓库初始化后立即切换至 `codex/phase-1-readonly-core`，没有在 `main` 上施工。
- `bootstrap.mjs` 只接受 `pnpm@11.19.0` 注入的可信入口，并以当前 Node 进程、`shell: false` 执行冻结锁文件安装。
- pnpm 11 默认拒绝未声明的依赖构建脚本；工作区只允许 Vitest 所需的 `esbuild`，没有开放其他脚本权限。
- CI 使用 Windows，覆盖 Node `22.19.0` 与 `24.x`，并拒绝验证命令产生的工作区变化。

## 测试与结果

- `pnpm vitest run tests/contract/workspace-contract.test.ts`（实现前）：失败，空仓库缺少 `package.json`，符合红测预期。
- `pnpm bootstrap`：通过。
- `pnpm vitest run tests/contract/workspace-contract.test.ts`：1 个测试通过。
- `pnpm check`：typecheck、build 和测试全部通过。
- 第二次 `pnpm bootstrap`：通过；`pnpm-lock.yaml` 的 SHA-256 前后均为 `274893CB93F2D1D25349179E7C2782E670BB1C247ABD51E7A4FDB5CB77AE9656`。
- `git diff --check`：提交前执行。

## 遗留风险

- 本机只实际运行 Node `24.7.0`；Node `22.19.0` 由已登记的 GitHub Actions 矩阵验证。
- 阶段一其余包尚未创建；当前仅提供工作区骨架和 `CONTRACT_SCHEMA_VERSION = 1`。
