# Bundle 入口检测修复（2026-09-06）

## 问题与证据

候选 Engine 0.1.17 在发现 rc1 web 配置时，将 `dsh-obsidian-session-reference-suite@0.3.2` 误报为无法加载的插件组件。只读逐项核查当前 10 个 bundle：其余 9 项可解析根 JS 入口；Suite 的清单与 `cordis.patch.yml` 均存在，但只导出补丁和 `package.json`，没有根 JS 入口。旧检测器复用运行模块解析，执行 `require.resolve(name)` 时得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

实际安装的官方 `@deepseek-ai/dsh-app-boot@0.1.2-rc.1` 加载器 `lib/index.js` 第 826–830 行按安装目录、配置目录顺序解析 bundle 目录，第 860–868 行读取清单中的 `dsh.bundle.patch` 并加载补丁；这个契约不要求 bundle 自身提供 JS 根入口。此诊断只读取真实安装文件，未运行真实 CLI 启动或修改真实配置。

## 修改

- 将清单解析和可执行模块解析分开。Bundle 使用清单与补丁契约；会话运行模块仍要求入口文件存在、可解析并位于所选实例内。
- 保留包名、版本字段校验，保留安装目录优先、真实路径归属检查，以及补丁文件必须在包目录内、可读取、YAML 合法且为数组的检查。
- Maintenance 自身包含实际运行插件，继续单独要求其 JS 入口有效，并确认入口解析所得清单与 bundle 清单一致，避免将另一份插件当作当前包。
- 不修改用户 bundles 列表，不将 Suite 成员提升到顶层，不改变 Launcher 能力凭据要求。缺少 Launcher 能力文件的独立问题仍按原逻辑显示。

## 验证

新增合成目录回归覆盖：与 Suite 相同的无根入口导出结构可以发现和接入；运行模块缺少入口仍拒绝；损坏 YAML、非数组补丁、缺失补丁、越出包目录的补丁均拒绝发现及接入。既有 Maintenance 入口缺失保护保持有效。

- `node node_modules/vitest/vitest.mjs run apps/engine/test/integrations.test.ts apps/engine/test/integration-api.test.ts --maxWorkers=1`：2 个测试文件、38 项测试全部通过（接入 26 项、HTTP 12 项）。
- `node node_modules/typescript/bin/tsc -p apps/engine/tsconfig.json --noEmit`：通过。
- 首次 pnpm 调用因依赖状态检查试图重装而在无交互终端中中止；改用当前已安装工具的直接入口，不重装依赖。测试编译子进程的沙箱 `EPERM` 经隔离测试权限重试后通过。

所有写入仅在隔离工作树与标记测试临时目录内，无真实实例写入，无版本变更或提交。
