# P22：可复现发布包与官方 rc.2 隔离验收

## 结果

- 新增 Engine+Dashboard 与 `dsh-session-maintenance` 两个独立 tgz、稳定 manifest、SHA-256、依赖输入清单和 Windows 双击启动入口。
- 构建两次可逐字节复现；发布扫描拒绝 EAC、`web-desktop`、旧同步插件、`/codex-sync`、本机源码路径、file/link/workspace 依赖和 bearer capability。
- Engine 直接提供 `/dashboard/` 静态页面；固定 CSP、asset 路径和无 traversal 路由。浏览器仍只使用 HttpOnly UI session 与 CSRF。
- 修复发布前被真实 loader 验收发现的 client 产物格式：从普通 ESM 改为官方 `window.__ModuleLoader__.load` CJS factory。合成快测也改为验证 factory 注册，不再用 Node `import()` 冒充浏览器 loader。
- 新增两层隔离验收：合成 fixture 负责快速契约/卸载/状态保留，真实验收通过官方命令把 tgz 安装到临时 `DSH_HOME`，启动本机官方 DSH `0.1.1-rc.2` 最小 Web 栈。
- 真实验收确认 client graph、client bundle route、host proxy、Core materialization 和 loader diagnostics；进程、profile 和状态都在已标记临时目录，正式 DSH home 未被写入。
- README 与安装、升级、卸载、恢复文档已更新；正式 `web` profile 只生成替换预览，没有执行安装或卸载。

## 打包与安全边界

- 插件 host 内联本项目内部包，只把官方 rc.2 peer contracts 留给目标 runtime；发布 manifest 不含 `workspace:*`。
- 打包的 `rc2-host.js` hash 必须与锁定 materialization 一致。
- Dashboard 凭据扫描按实际 host roots 和 bearer 形态检查，避免把 minified JavaScript 中的正则源码误判为 Windows 路径。
- 官方验收使用 `DSH_INSTALL_ROOT` 只读复用 runtime；`DSH_HOME` 始终覆盖为 `mkdtemp` 目录。清理前同时验证 temp 相对路径和专用 marker。

## 验证

- `pnpm package:phase2`、`pnpm verify:phase2-package`、`pnpm assert:phase2-portable` 通过。
- `pnpm accept:phase2-isolated` 与 `pnpm accept:phase2-official` 通过。
- Phase 1 为 2 files / 3 tests，Phase 2 聚焦为 31 files / 57 tests，全工作区串行为 62 files / 131 tests；typecheck、build、通用 portability 和 `git diff --check` 均通过。
- 详细版本、hash 和正式 profile 未执行边界见 `docs/validation/phase-2-acceptance.md`。
