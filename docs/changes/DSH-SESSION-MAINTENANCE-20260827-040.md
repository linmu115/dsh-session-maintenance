# Plugin Manager 会话维护看板入口

## 问题

`dsh-session-maintenance` 已有独立 Dashboard 和 DSH 页面入口，但插件发布包没有 Manager 的 `dsh-management/panel.yaml`，Host 也没有登记 `resourceManagementActions`。因此 Plugin Manager 只能展示 README，不能显示可用的操作面板。

## 修复

- 插件版本提升到 `0.1.1`。
- 按 `dsh-management-panel-builder` Contract v2 新增 Manager 面板，提供“打开会话维护看板”“检查维护引擎”“扫描已登记会话”三个操作。
- 三个按钮复用现有 `RestrictedEngineProxy`，没有复制扫描或看板业务逻辑。
- Manager 服务保持可选：未安装 Manager 时，原有右键菜单、右下角按钮和 API 网关继续工作。
- 打开看板动作只接受 Engine 签发的 `127.0.0.1` HTTP 地址，并在 Manager HTTP 回执完成后调用系统默认浏览器。
- 自定义 Phase 2 打包器现在把 `dsh-management/panel.yaml` 纳入插件 tgz，并从组件 manifest 读取版本，避免再次遗漏。
- 插件的标准 `pnpm pack` 也会生成相同边界的自包含 Host/Client bundle，不再把本地 `@linmu/*` workspace 包误写成运行时依赖；因此 Maintenance 可以从精确 Git commit 构建、预览和部署该插件。
- GitHub Windows CI 明确把 `TEMP/TMP` 指向 `runner.temp`，避免系统短路径别名让合成 fixture 安全边界误判；生产安全守卫本身没有放宽。

## 位置

- `plugins/dsh-session-maintenance/dsh-management/panel.yaml`
- `plugins/dsh-session-maintenance/src/manager-actions.ts`
- `plugins/dsh-session-maintenance/src/dashboard-launcher.ts`
- `plugins/dsh-session-maintenance/src/index.ts`
- `scripts/package-phase2.mjs`
- `plugins/dsh-session-maintenance/scripts/build.mjs`

## 验证

- Manager 动作声明与 Host 注册 ID 一致。
- Dashboard URL 只允许本机 loopback HTTP。
- 插件单测、类型检查、构建与发布包内容检查通过。
- 安装到官方 `web` profile 后，在 Plugin Manager 的参数设置页完成真实动作验收。
