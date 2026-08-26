# P8：Codex 0.146.0 只读适配器

## 目标

实现 `SessionReadAdapter` 的 Codex `0.146.0` 契约：版本/schema 探测、metadata-first 列表、稳定读取、规范化和只读指纹验证。

## 修改文件

- 新增适配器包：`packages/adapter-codex-read/package.json`、`tsconfig.json`
- 探测/目录：`src/probe.ts`、`src/catalog.ts`
- 稳定读取/解析：`src/stable-read.ts`、`src/parser.ts`
- 规范化/入口：`src/normalizer.ts`、`src/index.ts`
- 测试：`test/codex-adapter.test.ts`、`test/codex-schema.test.ts`
- 工作区锁文件：`pnpm-lock.yaml`

## 支持契约

- 平台版本：`0.146.0`
- 适配器：`codex-read`
- schema fingerprint：`codex-read/0.146.0/schema-1:68acdd089a73136b600be0528dac62ae617a3427b4648444118bf0612108e616`
- 必需 thread 列：`archived, created_at, cwd, id, name, rollout_path, title, updated_at`
- 必需 envelope：`session_meta, response_item`

## 关键决策

- 不支持的平台版本在打开 SQLite/rollout 前返回 `unsupported`；thread 列 fingerprint 不匹配时也在正文读取前停止。
- SQLite 始终以 `readOnly: true` 打开。`list()` 只查询 thread 元数据并 stat rollout，不解析正文。
- rollout 必须经 realpath 后仍位于已登记 Codex root；绝对或相对逃逸路径返回 `LIVE_HOME_FORBIDDEN`。
- `observe()` 比较读取前后的 size/mtimeNs，并对正文设置 64 MiB、单行 8 MiB 上限；变化返回可重试 `unstable`，不建立版本。
- JSONL 拒绝截断、非法 envelope、重复 `session_meta` 和 catalog/session_meta ID 不一致。
- 支持的 user/assistant/system message 按来源顺序规范化；图片转附件。未知 envelope 保存到 `extensions.codexEnvelope`，兼容性降级，绝不伪装为 DSH 原生工具调用。
- workspace ID 由 cwd 的稳定 hash 产生，不暴露绝对路径。`verify()` 重新只读观察并执行精确 fingerprint 集合比较。
- 测试通过注入 P7 fixture guard；生产依赖仍只有 contracts/domain，没有引入 test-support 运行依赖。

## 测试与结果

- `pnpm vitest run packages/adapter-codex-read/test`（实现前）：2 个 suite 因包/依赖不存在失败，符合红测预期。
- 同一命令（实现后）：2 个文件、6 个测试通过。
- 100 个 thread 的 `list()`：`rolloutBodyReads = 0`、`rolloutProbeReads = 0`；只观察一个 thread 时完整正文读取计数为 1。
- 覆盖未知版本/schema、截断 JSONL、路径逃逸、重复 session_meta、读取中变化和未知 envelope 降级。
- `pnpm --filter @linmu/dsh-adapter-codex-read typecheck`：通过。
- `pnpm check`：5 个包 typecheck/build 通过，12 个测试文件、39 个测试通过。
- `git diff --check`：通过。

## 遗留风险

- 当前契约只覆盖固定 `0.146.0` fixture；任何 Codex 列或 envelope 契约变化都会暂停兼容，需要新增脱敏 fixture 后适配。
- 列表会对每个 rollout 做一次 stat；P10 的发现服务会按 hint/cursor 缓存并限制候选完整读取并发。
