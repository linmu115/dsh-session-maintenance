# Phase 2 验收记录：DSH 写入与维护界面

**日期：** 2026-08-27  
**分支：** `codex/phase-2-dsh-core-extension`  
**支持契约：** 官方 DSH `0.1.1-rc.2` / Cordis `4.0.1`

## 结论

Phase 2 工程门禁通过。版本锁定 Core 扩展、远程 Gateway、可恢复写事务、Codex → DSH 安全快进、类型化 API、独立 Dashboard、DSH 入口插件和可复现发布包已闭环。正式 `web` profile 没有被修改；旧 `dsh-codex-session-sync@0.3.3` 仍保持原状，等待用户审查替换预览后另行批准。

## 环境

- OS：Windows NT `10.0.26200.0`
- Node.js：`v24.7.0`；本机没有额外 Node 22 runtime，因此没有伪造双版本结果
- pnpm：`11.19.0`
- 官方 DSH runtime：`D:\AI\DeepSeek-Harness\runtime-0.1.1-rc.2`
- 测试并发：Windows 固定 `--maxWorkers=1 --testTimeout=15000`，避免 SQLite WAL/临时文件竞争造成假失败

## 发布产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `dsh-session-maintenance-engine-0.1.0.tgz` | 309,863 bytes | `b6e8e1ce3de432c183d86e40a22b9521f5b576c66076d910a181f93860a4e6b8` |
| `dsh-session-maintenance-0.1.0.tgz` | 96,931 bytes | `b887ef36700d62c0ec41a74a6264238fa87a655be0da0214001ccb1e13700174` |

`verify:phase2-package` 连续构建两次，两个 tgz 和 manifest 均逐字节一致。最终 release build 的来源提交与工作树是否干净由生成的 `phase2-manifest.json` 中 `sourceCommit` / `sourceDirty` 记录。

## 隔离官方 runtime 验收

`accept:phase2-official` 使用本机官方 rc.2 runtime，但把 `DSH_HOME`、profile、lockfile、node_modules、状态和 Engine fixture 全部放入带标记的 Windows 临时目录：

1. 通过官方 `dsh plugin --profile web add <tgz> --offline --ignore-scripts` 安装包；
2. 启动最小 `@deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app + dsh-session-maintenance`；
3. 确认 HTML client graph 包含插件；
4. 确认 `/plugins/dsh-session-maintenance/client.js` 返回官方 factory 注册格式；
5. 确认 host proxy 能到达隔离 Engine，Core probe 返回 `compatible`；
6. 扫描 loader 输出，不含 failed-loader、client-module drift 或插件错误；
7. 停止进程并只删除已验证 marker 的临时 profile。

报告结果：`officialInstaller`、`minimalWebStack`、`clientModuleGraph`、`clientBundleRoute`、`hostProxy`、`materializedCoreProbe`、`loaderDiagnostics` 全部 `passed`；`formalHomeTouched=false`。

合成快速验收继续覆盖 package host/client 注册、两个 endpoint、unload cleanup 与删除临时 profile 后 Engine state 保留。业务测试覆盖安全快进、分叉零写入、故障恢复、HMAC scope/重放拒绝、service/materialization drift 和 token/端口轮换。

## 最终门禁

| 门禁 | 结果 |
| --- | --- |
| 全工作区 typecheck / build | 通过 |
| Phase 1 回归 | 2 files / 3 tests 通过 |
| Phase 2 聚焦套件 | 31 files / 57 tests 通过 |
| 全工作区串行测试 | 62 files / 131 tests 通过 |
| 两次可复现打包 | 通过 |
| 19 个发布文件便携性/敏感信息扫描 | 通过 |
| 合成隔离验收 | 通过 |
| 官方 rc.2 临时 profile 验收 | 通过 |
| 通用源码便携性门禁 | 通过 |
| `git diff --check` | 通过 |

## 尚未执行的人工门禁

正式 `web` profile 的 package/lock/bundle 替换与旧插件卸载尚未执行。只读预览位于 `docs/deployment/FORMAL-PROFILE-REPLACEMENT-PREVIEW.md`。该事务必须在用户明确批准后单独执行；失败时恢复整个旧 package/lock/bundle 组合。
