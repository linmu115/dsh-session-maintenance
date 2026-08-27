# Phase 3 验收记录：Codex 延续任务

**日期：** 2026-08-27  
**分支：** `codex/phase-3-codex-continuation`  
**支持契约：** Codex CLI `0.146.0` / app-server v2

## 验收结论

Phase 3 通过。维护引擎可以从精确 DSH 版本预览上下文预算，创建、验证并绑定新的原生 Codex 任务；进程中断后的验证可以恢复且不会重复创建。显式双父解析会保留两个原分支，并以独立解析节点作为新任务的共同版本。

## 自动验证

- `pnpm test:phase3`：4 个测试文件、6 个高价值测试通过。
- `pnpm typecheck`：全部 13 个工作区项目通过。
- `pnpm build`：全部 13 个可构建工作区项目通过。
- `pnpm assert:portable`：综合分支 233 个文本文件通过可迁移性检查。
- Codex plugin validator：通过。
- 路线 A/B 合并后 `pnpm test`：41 个测试文件、95 个测试全部通过。

目标场景覆盖：

- 完整/checkpoint/结构化摘要预算与不可变来源；
- DSH 工具事件降格为可追溯导入记录；
- app-server 版本漂移失败关闭；
- 创建后验证失败保留 thread ID，重启后恢复；
- HTTP 与 MCP 共用 job ID 和业务错误码；
- 双父、共同祖先、合并说明、来源 hash 和原分支不移动；
- 相同请求只执行一次 `thread/start`。

## 本机只读契约核对

- `codex --version`：`codex-cli 0.146.0`。
- 生产 Adapter 只执行 `initialize`，返回 `compatible`，契约指纹为 `codex-continuation/0.146.0/app-server-v2:6ae232c16f4d6665472bdf054b75d688b7cb6f468e0e62777b91b24f16329473`。
- 未调用 `thread/start`，因此本次验收没有在真实 Codex Home 创建任务。
- 首次核对发现 Windows 不能由 Node 直接启动 npm `codex.cmd`；Adapter 已改为解析官方 npm shim 并由当前 Node 直接启动 `@openai/codex/bin/codex.js`，不启用 shell。修复后同一只读核对通过。
- 综合分支构建同时验证了 DSH Core 物化锁；源码与生成 JavaScript 均先规范化 CRLF/LF，再计算 hash，避免 Windows checkout 造成虚假的产物漂移。

## 保持关闭的边界

- Phase 3 不修改 Codex rollout、索引或 SQLite，不提供原生双向镜像。
- 综合分支已包含通过 P16 验收的可选 `WriteService`；默认 composition 仍不附着真实 Core gateway，因此未配置时继续返回 `CAPABILITY_NOT_AVAILABLE`，也未部署到正式 DSH profile。
- 未在真实 Codex Home 创建人工验收任务；用户需要时可从 CLI、loopback API 或 Codex 插件明确创建。
