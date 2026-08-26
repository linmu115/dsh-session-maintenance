# P11：只读 Engine 与 CLI

## 目标

用一个 composition root 组合配置、SQLite、对象库、Discovery、Planner 和两个平台只读适配器，并提供固定的 `dsh-session-maint` 命令面。第一阶段的写操作明确拒绝。

## 修改文件

- Engine 应用包：`apps/engine/package.json`、`tsconfig.json`
- 私有配置：`apps/engine/src/config.ts`
- 统一组合入口：`apps/engine/src/composition-root.ts`
- Engine 实现：`apps/engine/src/engine.ts`
- CLI 与二进制入口：`apps/engine/src/cli.ts`、`main.ts`、`index.ts`
- CLI 夹具与测试：`apps/engine/test/helpers.ts`、`config.test.ts`、`cli.test.ts`
- 工作区测试发现：`vitest.config.ts`
- 依赖锁：`pnpm-lock.yaml`

## 关键决策

- `config.yaml` 只允许 schema version 1；平台 root 只在受信 CLI 的 `instance add` 接收。
- 注册前解析真实路径并执行适配器 probe；重复 ID、错误平台版本或错误路径不会写配置。
- 配置通过同目录临时文件、`fsync` 和原子 rename 落盘。
- CLI、后续 HTTP 和测试都使用同一个 `createReadOnlyComposition()`；命令本身不自行打开 SQLite 或构造适配器。
- `scan` 只调用 P10 Discovery，继续保证 `platformWrites: 0`。
- `diff`、`plan` 读取仓储中的 observed heads 与内容对象；plan 只持久化不可变 dry-run 计划。
- `apply` 和 `restore` 固定返回 `CAPABILITY_NOT_AVAILABLE` 与退出码 2，且不会创建事务目录。
- JSON 输出只含 DTO、错误码和诊断消息，不输出会话正文或认证材料。

## 测试与结果

- 红测先因 `apps/engine/src/cli.ts` 不存在失败，符合预期。
- 配置测试验证 schema 1、探测后的 realpath 和重复 instance 拒绝。
- CLI 测试验证首次扫描生成一个版本、第二次扫描零版本、Codex fixture 哈希不变。
- `apply --plan plan_x` 返回退出码 2 和 `CAPABILITY_NOT_AVAILABLE`。
- `pnpm check`：7 个包 typecheck/build 通过，19 个测试文件、53 个测试通过。
- `git diff --check`：通过。

## 后续边界

- 当前 CLI 同步执行扫描；P12 将通过持久化 job 和 SSE 对 HTTP 客户端暴露长任务。
- Phase 1 仍没有平台写适配器、apply 或 restore 实现。
