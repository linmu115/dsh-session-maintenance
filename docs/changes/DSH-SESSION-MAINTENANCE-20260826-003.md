# P3：规范化与稳定 Hash

## 目标

提供确定性的 canonical JSON、SHA-256 和会话规范化，使平台观察噪声不改变版本身份，并把正文与可同步元数据的身份分开。

## 修改文件

- 新增领域包：`packages/session-domain/package.json`、`tsconfig.json`
- 规范化实现：`src/canonical-json.ts`、`src/normalize.ts`、`src/index.ts`
- 测试：`test/normalize.test.ts`
- 开发解析条件：根 `tsconfig.base.json`、`vitest.config.ts`
- 工作区锁文件：`pnpm-lock.yaml`

## 关键决策

- canonical JSON 递归按 UTF-16 字符序排序对象键、保留数组顺序，并拒绝非有限数字、`undefined`、函数、Symbol、BigInt、稀疏数组、非普通对象和循环引用。
- SHA-256 直接编码 canonical JSON 的 UTF-8 字节，不依赖本机区域设置、路径或时间戳。
- 事件 ID 为 `ev_` 加 24 位 SHA-256 前缀；输入包括平台来源身份与语义字段，不包括扫描路径、扫描时间、PID、端口或日志位置。
- body hash 使用显式字段白名单，只覆盖有序事件和稳定工作区身份；新增 DTO 字段不会自动污染版本身份。
- metadata hash 只覆盖标题与归档状态。来源采集时间保留在 provenance 中，但不参与两类 hash。
- 父事件先映射为规范化事件 ID；重复 source ID、缺失父节点、自引用或非法 sequence 会被拒绝。
- TypeScript/Vitest 使用 `development` export condition，使干净 checkout 在尚未构建 `dist` 时仍能按 workspace 源码完成 typecheck。

## 测试与结果

- `pnpm vitest run packages/session-domain/test/normalize.test.ts`（实现前）：失败，缺少领域入口，符合红测预期。
- `pnpm vitest run packages/session-domain/test/normalize.test.ts`：5 个测试通过；覆盖递归键排序、Unicode、数组/附件顺序、非法 JSON、循环、观察噪声、标题/归档分离、语义编辑、父 ID 和工作区身份。
- `pnpm --filter @linmu/dsh-session-domain typecheck`：通过。
- `pnpm check`：3 个测试文件、9 个测试全部通过，两个包 typecheck/build 通过。
- `git diff --check`：通过。

## 遗留风险

- 事件排序由只读适配器按契约提供；领域层保留输入事件顺序，不按时间戳重排。
- 事件 ID 使用 96 位截断作为可读 ID，完整正文身份仍使用 256 位 body hash；持久层将在后续对任何 ID/hash 碰撞显式报错。
