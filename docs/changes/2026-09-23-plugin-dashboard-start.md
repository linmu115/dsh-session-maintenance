# DSH 插件一键启动 Maintenance 看板

## 行为

DSH 设置 → 会话维护中的按钮现名为“启动看板”。Engine 在线时直接取得一次性看板入口；Engine 离线时，宿主 adapter 根据本机 `engine-installation.json` 校验安装目录，并调用发行包自带的 Windows 独立启动脚本。脚本通过系统进程入口创建启动进程，避免 Engine 成为 DSH 实例的子进程；就绪后按钮在当前浏览器标签页打开看板。Maintenance 核心未加入 DSH、Launcher 或其他插件的启动逻辑。

插件只在点击全局看板按钮时尝试启动 Engine。其他代理操作不会因此自动启动。看板地址只接受本机 HTTP 的 `/ui/claim` 路径；启动失败时设置页显示错误。发行包现在包含自身的 Windows 维护脚本，无需依赖源码工作区里的脚本。

## 安装与验证

- Engine `0.1.43-rc2.94`，DSH 接入插件 `0.2.27-rc2.78`，Dashboard `0.1.20` 已安装在稳定 ID `i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5` 的 web 测试实例。Launcher 产品文件未改。
- 更新前按正常停止流程退出实例和 Engine，备份选中的元数据库、安装描述符和实例会话、插件状态，再替换发行包。安装验证与宿主目录修复返回 `connected`、`issues: []`；最终身份回执的 Engine 版本为 `.94`。
- 248 项插件测试、类型检查和 41 项发行前集成验证通过。测试覆盖离线自动启动、在线复用、其他操作不触发启动、安装记录校验和设置按钮跳转。
- 浏览器实测：在线点击直接进入 Maintenance 看板；最终 `.94/.78` 离线点击创建 Engine PID `49820` 并打开看板。正常停止测试实例后，该 PID 与监听端口 `22139` 仍存在。随后已从 Launcher 重新启动测试实例，Maintenance ready。

备份和发行包位于 `D:/AI/DeepSeekHarness-Plugin/artifacts/host-sync-20260923/`，本次对应 `engine93-final-backup`、`backup77`、`release78` 和 `receipts78`。

## 边界

这是插件入口与 Engine 生命周期的验收，没有重做完整会话双向同步矩阵。现有 portable 断言仍报告 Engine 代码中的既有 `D:\DSHworkplace` 默认路径和插件安装说明中的绝对示例路径；本次启动实现已去除新增的绝对系统路径。这两项不影响当前 Windows 测试安装，但不能据此宣称发行包的全部可移植性检查通过。
