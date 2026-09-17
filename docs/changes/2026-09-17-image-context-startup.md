# 图片适配升级后的启动恢复

Engine 0.1.33-rc2.32 修复分支会话继承 maintenance/canonical-event 时的恢复失败。只接受具有正确转换器、有效 canonical schema、匹配内容和投影策略、且无活跃操作的忽略型回执，并保留证据以还原原事件。GPT 格式扩展明确接纳 0.5.0-dev.4。

验证：适配器及扩展 79 项测试通过；明确 dev.4 的扩展与运行时校验 11 项通过；三个相关工程类型检查通过。真实待恢复操作的 426 个事件通过只读归一化，正式 afterExit 完成恢复。

部署曾遗漏独立适配 worker 和实例绑定更新，用户再次启动仍失败。同步 worker 后，通过正式 repair 重建绑定；Launcher 于 23:05:23 已就绪，新运行 running，旧运行 recovered，认证页面返回 HTTP 200。未清除待恢复记录，未直接修改数据库状态，未重装其它插件。真实用户会话发送仍待验收。

完整来源及纠偏见 [开发历程](../project/records/history/image-startup.md)。
