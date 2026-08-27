# P28：Phase 3 隔离验收与交付

## 结果

- 增加 `test:phase3`，把预算、app-server 契约、HTTP/MCP 契约和隔离端到端收敛为一次精简验收。
- README 更新为当前能力边界，并补充 Codex target、普通延续和显式双父解析的入口。
- 新增 `docs/validation/phase-3-validation.md`，记录测试、构建、可迁移性、插件校验和本机只读契约证据。
- 本机核对暴露并修复 Windows npm shim 启动缺口：生产 Adapter 不再直接 spawn `codex.cmd`，而是验证官方 npm entry 后用 Node 启动，继续保持 `shell: false`。

## 验证

- Phase 3：4 文件 / 6 tests 通过。
- 全 workspace typecheck/build：通过。
- portable：203 个文本文件通过。
- Codex plugin validator：通过。
- 本机 Codex 0.146.0 app-server `initialize`：compatible；未调用 `thread/start`。
