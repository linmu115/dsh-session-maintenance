# 修复已安装贴纸与知识链接版本兼容声明

Engine 0.1.33-rc2.40 的扩展名单仅接受 Sticker 0.7.4-rc2.3 与 Companion 0.7.0-rc2.1 等旧版本；目标实例此前已经安装 Sticker 0.7.4-rc2.5、Companion 0.7.0-rc2.3。UI 更新后的真实业务检查确认两域为 incompatible，legacy-state 返回 KNOWLEDGE_UNAVAILABLE。此问题在此次 UI 包的替换前已经存在于安装组合中，本次安装前的验证没有覆盖 Engine 业务兼容名单。

Engine 0.1.33-rc2.41 精确加入这两个已安装版本，保留旧版本和严格白名单；不扩大到任意未来版本，不修改对象 schema、Vault 绑定、历史内容或同步范围。运行 attestation 增加 .41。

把扩展组合及会话知识测试更新为真实安装版本，修复前两个用例复现相同拒绝；修复后三文件 13 项通过，包含 sticker 保存/恢复/迁移、知识链接读写、跨会话隔离、未知版本拒绝、attestation。所有测试使用合成临时 home。

Engine 类型检查通过，发行可移植检查通过（43 个文件）。发行包含已确认 Dashboard 0.1.6。Maintenance 插件仍为 0.2.26-rc2.29，包内四项 JS 运行入口与已安装插件一致；旧归档的 business-pages.d.ts 与当前源码不同，因此没有强行复用不匹配归档，而是使用标准打包生成，当前实例插件不替换。当前实例已启动，不能替换运行中的 Engine 或绕过 Launcher 停止；发行先准备，正式激活须在目标实例由 Launcher 正常关闭后执行。最终状态以工作区 UI 实施报告和安装回执为准。
