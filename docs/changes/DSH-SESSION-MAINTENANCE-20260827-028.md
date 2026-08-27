# P28：Phase 3 隔离验收与交付

## 结果

- 增加 `test:phase3`，把预算、app-server 契约、HTTP/MCP 契约和隔离端到端收敛为一次精简验收。
- README 更新为当前能力边界，并补充 Codex target、普通延续和显式双父解析的入口。
- 新增 `docs/validation/phase-3-validation.md`，记录测试、构建、可迁移性、插件校验和本机只读契约证据。
- 本机核对暴露并修复 Windows npm shim 启动缺口：生产 Adapter 不再直接 spawn `codex.cmd`，而是验证官方 npm entry 后用 Node 启动，继续保持 `shell: false`。
- 两条路线合并构建时发现 Git checkout 的 CRLF 会改变少量 TypeScript 保留文本的原始字节；Core 物化 hash 现统一以 LF 规范化后的 JavaScript 文本计算，跨 Windows checkout 保持相同锁值。

## 验证

- Phase 3：4 文件 / 6 tests 通过。
- 全 workspace typecheck/build：通过。
- 路线 A/B 合并回归：41 文件 / 95 tests 通过。
- portable：综合分支 233 个文本文件通过。
- Codex plugin validator：通过。
- 本机 Codex 0.146.0 app-server `initialize`：compatible；未调用 `thread/start`。
