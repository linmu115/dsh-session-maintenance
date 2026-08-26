# P9：官方 DSH 0.1.1-rc.2 只读适配器

## 目标

实现官方 DSH `0.1.1-rc.2` 的 metadata-first 只读适配器和有界多帧 Zstd 解码器，规范化可见消息与带来源的工具导入记录，并完成批次 B 门禁。

## 修改文件

- 新增适配器包：`packages/adapter-dsh/package.json`、`tsconfig.json`
- Zstd/测试编码：`src/zstd-codec.ts`、`src/testing.ts`
- 目录/读取：`src/reader.ts`
- 探测/规范化/入口：`src/probe.ts`、`src/normalizer.ts`、`src/index.ts`
- 测试：`test/zstd-codec.test.ts`、`test/dsh-adapter.test.ts`
- 批次证据：`docs/validation/phase-1-progress.md`
- 工作区锁文件：`pnpm-lock.yaml`

## 支持契约

- 平台版本：`0.1.1-rc.2`
- 适配器：`dsh-read`
- schema fingerprint：`dsh-read/0.1.1-rc.2/session-v0:3d9c5fa35c22ede16cfb69175ac4ee05ef07f41cb84383a4c894ea0b0d5ed6b6`
- session header：`{ type: "session", version: 0 }`

## 关键决策

- Zstd scanner 校验标准 magic、frame descriptor 未使用/保留位、字典/FCS 字段、block type/边界、128 KiB block 上限和可选 checksum 边界；实际 checksum 由 Node Zstd 解压器验证。
- 限制为 64 MiB 压缩 artifact、256 MiB 解压输出、100 万 JSONL 行和每行 8 MiB。
- `decodeHeaderFrame()` 只处理首帧；目录列表最多从文件读取 1 MiB 来定位并解压 header，不读取事件 frame。
- 只枚举 `sessions/<project>/<session>/session.jsonl.zstd`。项目、会话和 artifact 均须 realpath 包含于已登记 root；junction/symlink 逃逸返回 `LIVE_HOME_FORBIDDEN`。
- header ID 必须唯一并与 session 目录名一致；未知 DSH 版本或 header version 返回不兼容诊断，不猜测解析。
- visible user/assistant 事件转为消息；相邻 tool call/result 合并为一个明确的 `tool-import`，extensions 固定 `importedFrom: DSH`，不会伪造成 Codex 原生工具执行。
- 未知事件保留为 source metadata 并标记 degraded。workspace ID 使用已登记 instance/project 映射的 hash，不使用 header 原始 cwd。
- 在修正实现时确认 Zstd frame header 后不存在独立 header-checksum 字节；移除错误偏移后仍保留 content checksum 验证和所有边界限制。
- Fixture encoder 只通过 `./testing` 子路径发布，不从生产入口导出。

## 测试与结果

- `pnpm vitest run packages/adapter-dsh/test`（实现前）：2 个 suite 因包不存在失败，符合红测预期。
- 首轮实现测试暴露 frame block 偏移错误；按 Node 实际 Zstd frame 字节校正后，2 个文件、6 个测试全部通过。
- 覆盖两帧、invalid magic、reserved bit、checksum 篡改、截断第二帧、oversized block、未知平台/header 版本、重复 ID 和 junction 逃逸。
- 100 个 session 的 `list()`：`headerFrameReads = 100`、`fullArtifactReads = 0`；观察一个后完整读取计数为 1。
- probe/list/observe/normalize/verify 前后 DSH fixture tree SHA-256 相同。
- `pnpm --filter @linmu/dsh-adapter-dsh typecheck`：通过。
- `pnpm check`：6 个包 typecheck/build 通过，14 个测试文件、45 个测试通过。
- `git diff --check`：通过。

## 遗留风险

- 当前只支持标准 Zstd frame；skippable frame 和未知 session header 均安全拒绝。
- Projection fixture 只覆盖标题/归档最小字段；更多官方 storage 版本需要先增加对应脱敏契约样本。
