# P5：不可变 SQLite/Zstd 存储

## 目标

建立 schema version 1 的 SQLite 元数据仓储和以未压缩字节 SHA-256 寻址的 Zstd 对象存储，支持幂等写入、重开、平台观察引用、可达对象枚举和受保护 GC。

## 修改文件

- 新增存储包：`packages/session-store/package.json`、`tsconfig.json`
- 数据库：`src/schema.ts`、`src/database.ts`
- 对象存储：`src/object-store.ts`
- 仓储：`src/repository.ts`、`src/index.ts`
- 测试：`test/object-store.test.ts`、`test/repository.test.ts`
- 工作区锁文件：`pnpm-lock.yaml`

## 关键决策

- migration 001 一次建立计划要求的十张业务表；数据库打开时启用 foreign keys、WAL 和 5000 ms busy timeout，并在 `BEGIN IMMEDIATE` 内迁移。
- 发现数据库 schema 高于当前版本时先关闭句柄再拒绝打开，不猜测降级。
- 对象 ID 固定为未压缩字节的 `sha256:<64 hex>`；Zstd 开启 frame checksum，压缩参数、路径和时间不参与身份。
- 对象先写入同目录 `wx` 临时文件并 fsync，再原子 rename；并发同内容写入最终验证同一个对象。
- 每次 `get()` 都解压并重新计算未压缩 hash；丢失、截断、解压失败或 hash 不符统一返回 `OBJECT_CORRUPT`。
- `putVersion()` 在开启 SQLite 事务前验证正文对象，然后保存 canonical manifest；相同重试返回原 manifest，同 ID 不同 manifest 返回 `VERSION_ID_COLLISION`。
- 平台观察只移动 `platform_refs`。可达性从平台 ref、canonical ref 和 checkpoint ref 向父节点递归，再映射正文对象。
- GC 只处理符合年龄条件且不可达的对象；dry-run 只报告候选及压缩字节数，不删除文件。

## 测试与结果

- `pnpm vitest run packages/session-store/test`（实现前）：2 个 suite 因包不存在失败，符合红测预期。
- 同一命令（实现后）：2 个文件、4 个测试通过；覆盖顺序/并发去重、截断 Zstd、dry-run GC、foreign keys/WAL、重开、幂等版本、新版 schema 和身份碰撞。
- `pnpm --filter @linmu/dsh-session-store typecheck`：通过。
- `pnpm check`：3 个包 typecheck/build 通过，7 个测试文件、20 个测试通过。
- `git diff --check`：通过。

## 遗留风险

- Node 24.7 仍将 `node:sqlite` 标记为 Experimental；项目固定的 Node 22.19/24.x 兼容矩阵会持续运行契约测试。
- P5 只实现计划规定的仓储子集；计划持久化由 P6 增加，其余 `SessionRepository` 查询/绑定方法由 P10 完成。
