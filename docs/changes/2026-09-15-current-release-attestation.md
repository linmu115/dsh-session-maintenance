# 当前 Engine 与插件版本接入门禁

Engine 声明已更新为 `0.1.33-rc2.19`，但运行回执的精确版本枚举仅列到 `.18`；插件声明为 `0.2.26-rc2.15`，Launcher 发现逻辑中的两处精确列表仅列到 `.14`。这导致当前 Engine 无法接受当前组合产生的回执，并把已安装插件判为尚未就绪。

本次只增加当前已声明版本的三个精确允许项：Engine 回执 `.19`、通用插件识别 `.15`、0.1.5 插件识别 `.15`。没有引入版本通配符，也没有从 package.json 自动允许未来发行版。实例、Profile、Launcher、包解析闭包、能力及每个文件的摘要核验保持不变。

回归直接读取当前两个 package.json 的版本，构造隔离 Launcher/Profile 和真实可解析的合成包，完成发现、运行回执检查、connect 和启动前 resolveRuntimeIntegration。未知未来 Engine、额外版本后缀、未允许插件，以及接入后被修改的 Engine 文件仍会被拒绝。通用与 0.1.5 两条插件发现路径都覆盖当前版本，原有较早候选拒绝用例保留。这里的 Adapter 验证器沿用测试桩；本用例不替代真实宿主能力验收。

修改前现有 `v3-runtime-attestation.test.ts` 在当前 package.json 版本用例中复现失败。修改后定向验证覆盖运行回执、实例接入、V3 policy、Provider 资源和 0.1.5 绑定；Engine 类型检查及重新构建将随本次最终包验证。Engine/plugin 版本不再递增，旧产物保留，重新打包使用独立 `engine-package-final` 目录。
