# Phase 1 验收记录

## 候选范围

- 分支：`codex/phase-1-readonly-core`
- 已验证基线提交：`d0accff8145270140448ebde7ec7a04532b2ed14`
- clean-clone 已验证内容提交：`92007253fb79c0f45d32cc94de6cc20942734f46`（后续 amendment 只追加本条验收证据）
- 平台契约：Codex `0.146.0`；官方 DSH `0.1.1-rc.2`
- 能力边界：只读发现、版本图、diff、dry-run plan、认证 loopback API 和 scan job

## 环境

- OS：Microsoft Windows NT `10.0.26200.0`
- Node.js：`v24.7.0`
- pnpm：`11.19.0`
- SQLite：Node `node:sqlite`，schema version 2，WAL + foreign keys
- 对象库：SHA-256 内容寻址 + Zstd

## 最终命令证据

| 命令 | 结果 |
| --- | --- |
| `pnpm verify:clean` | 通过；bootstrap 无依赖变化；8 个包 typecheck/build 通过；25 个测试文件、62 个测试通过 |
| `pnpm test:phase1` | 通过；2 个文件、3 个测试通过 |
| `pnpm assert:portable` | 通过；132 个文本文件完成静态门禁 |
| `git diff --check` | 通过 |
| 临时 `git clone --no-hardlinks` 后 `pnpm bootstrap && pnpm check` | 通过；25 个测试文件、62 个测试通过；克隆 worktree 保持 clean |

## 只读与幂等证据

- Codex 和 DSH synthetic fixture 在扫描前后分别计算相对路径+文件字节的 SHA-256；两组 before/after 断言完全相等。
- 第一次双平台扫描生成 2 个逻辑会话、2 个 binding、2 个 version；第二次扫描四项 created 计数全部为 0。
- DiscoveryResult 的 `platformWrites` 在所有扫描路径固定为字面量 0。
- canonical ref 在发现后仍为 `NULL`；发现不会选择主线。
- 同标题跨平台会话只生成低置信候选，不会自动绑定。
- 同一 Codex UUID 替换为无关根提问时返回 `IDENTITY_CONFLICT`。
- `apply`/`restore` CLI 返回退出码 2；HTTP 返回 501；没有创建平台事务或调用平台写接口。

## 性能与查询证据

- 1,000 个 synthetic catalog 项首次可完整发现。
- observation 最大并发实测不超过 4，SQLite 变更经单一 write queue 提交。
- 未变化的第二次扫描执行 0 次完整 observation。
- sessions 默认页 50、上限 200；读取第一页不访问内容对象。
- graph page 只读取目标逻辑会话的 manifest 和 refs，不访问正文对象。

## API 与恢复证据

- `127.0.0.1` 可启动；`0.0.0.0` 返回 `LOOPBACK_ONLY`。
- sessions 无 token 返回 401；恶意 Origin 返回 403。
- 64 KiB 以上 JSON 返回 413；带 `root` 的 scan body 因 strict schema 返回 400。
- scan 作业事件序列为 queued、running、progress、progress、completed，sequence 严格递增。
- running scan 重启后只 requeue 一次；未知中断 job 失败为 `RECOVERY_REQUIRED`。
- 客户端验证响应 DTO，错误消息中的 token canary 被替换为 `[REDACTED]`。

## 兼容与可迁移边界

- 未知 Codex/DSH 版本由 probe 返回 unsupported；不会猜测解析。
- fixture guard 已验证真实 home、无 marker 目录和越界 junction 均返回 `LIVE_HOME_FORBIDDEN`。
- runtime 不包含 EAC/web-desktop 路径、旧 synchronizer 依赖、机器绝对路径或 `file:`/`link:` 依赖。
- 状态库可以放到任意用户选择目录；迁移后需重新登记并 probe 新机器上的平台真实路径，不复制平台 `node_modules`。

## 未进入 Phase 1 的功能

- DSH/Codex 写适配器
- 原生双向镜像、合并解析版本和删除同步
- apply/restore 事务执行器
- Dashboard 与 DSH 插件 UI
