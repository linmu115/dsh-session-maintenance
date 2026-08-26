# P7：隔离沙箱与脱敏 Fixture

## 目标

为两平台只读适配器建立进程级测试边界和可重复的合成 Codex `0.146.0`、DSH `0.1.1-rc.2` home，保证默认测试无法误读真实会话。

## 修改文件

- 测试支持包：`packages/test-support/package.json`、`tsconfig.json`
- 沙箱：`src/sandbox.ts`
- 平台物化器：`src/codex-fixture.ts`、`src/dsh-fixture.ts`、`src/index.ts`
- 安全测试：`test/sandbox.test.ts`
- 脱敏来源：`fixtures/codex/0.146.0/*`、`fixtures/dsh/0.1.1-rc.2/*`
- 工作区锁文件：`pnpm-lock.yaml`

## 关键决策

- 沙箱只能创建在 `os.tmpdir()` 的唯一子目录，marker 是包含随机 UUID 的普通文件；临时目录根本身、缺失 marker、目录/junction marker 均被拒绝。
- `assertFixtureSandbox()` 对输入和 temp 根执行 realpath，再逐级查找 marker；越界 junction 即使位于已标记目录内也返回 `LIVE_HOME_FORBIDDEN`。
- Codex fixture 生成固定 `state_5.sqlite`、`session_index.jsonl` 和 rollout；所有路径与时间均为合成常量。
- DSH fixture 将固定 header 与事件分别压缩为两个带 checksum 的 Zstd frame，并生成固定 workspace/projection storage。
- 物化目标必须为空且位于同一个有效 marker 边界内，避免覆盖未知测试数据。
- 两份 manifest 固定平台版本，并明确声明 `synthetic: true`、`containsUserData: false`。

## 测试与结果

- `pnpm vitest run packages/test-support/test/sandbox.test.ts`（实现前）：suite 因包不存在失败，符合红测预期。
- 同一命令（实现后）：4 个测试通过；覆盖真实 home 拒绝、标记根/后代、缺失 marker、越界 junction、linked marker、两平台 byte-identical 物化和敏感形状扫描。
- `pnpm --filter @linmu/dsh-session-test-support typecheck`：通过。
- `pnpm check`：4 个包 typecheck/build 通过，10 个测试文件、33 个测试通过。
- `git diff --check`：通过。

## 遗留风险

- Fixture 只覆盖已确认的最小 schema 样本；P8/P9 会增加损坏、未知 envelope 和批量惰性读取变体。
- SQLite fixture 的字节确定性已在当前固定 Node/SQLite 运行时验证；CI 的 Node 22.19 与 24.x 矩阵会检测上游 SQLite 产物差异。
