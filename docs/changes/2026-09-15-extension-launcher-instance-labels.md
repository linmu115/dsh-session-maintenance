# 扩展面板显示 Launcher 副本名称

动态接入的 Launcher 副本不一定出现在 Engine 启动时读取的静态 `RegisteredInstance` 清单里。此前业务面板仅查该清单，导致已经接入的副本仍显示实例 ID。

`InstanceIntegrationService.instanceDisplayName(instanceId, profileId)` 现在从已有接入绑定确定该实例及 profile 所属的 Launcher 数据目录，再读取该目录 `config.json` 中对应 `instances[id].name`。这是显示名称查询，不改变接入状态或运行权限；不调用完整 discovery、宿主能力摘要、运行时鉴证或 profile/package 扫描。结果缓存 5 秒，同一批并发面板请求复用一次读取；接入列表刷新或接入操作会使缓存失效。

业务面板优先使用这一动态名称，随后回退到静态实例显示名，最后回退到原实例 ID。未绑定的 profile、无名条目、损坏配置、重复实例 ID 或有歧义的名称保留回退；不会把配置中的环境覆盖项等内容返回给浏览器。实例 ID、profile ID 和原有扩展数据归属不变。

验证使用两个纯合成测试：真实 Engine HTTP 路由在静态清单没有副本时返回动态名称，并保留跨 profile、静态实例及未知实例的正确回退；服务测试覆盖并发缓存、重命名刷新、重复 ID 与损坏 JSON，断言名称读取没有调用完整 discovery。测试通过，Engine 类型检查与 `git diff --check` 通过。未读取或修改真实副本数据；统一构建打包由发布任务在本提交后执行。
