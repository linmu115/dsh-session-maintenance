# 会话主干默认上下布局

用户要求绘画/会话贴纸产生的卡片与上下连接口一致，并让思维图主题对齐 DSH。配套版本为 ThoughtDAG 0.4.14-rc2.7、Maintenance 插件 0.2.26-rc2.13、Engine 0.1.33-rc2.17。

`SessionGraphStore.syncReference` 创建目标卡片后，把新增来源卡片放在目标上方，同一链横坐标一致。多个父节点在上方空闲列展开。上下间距 260px、横向列距 320px，按 300×200px 范围避让；仅决定新卡片位置，不搬动已保存卡片。恢复缺失目标时将目标置于已存在来源下方；草稿缺少 owner 卡片时在最下卡片下方补齐。重复同步保持已有坐标。

不改图 schema 2 或上下文权限。新 ThoughtDAG/Engine/插件版本加入兼容清单并保留旧项。主 profile 配置保持，发布只替换副本的 ThoughtDAG 与 Maintenance 包；共享 Engine 按原受管流程切换。

验证包括默认来源在上、重复同步幂等、多来源不重叠、已保存手动位置保留、缺失目标恢复和草稿归属补齐。相关扩展契约测试补齐 schema 2 与旧图待核验语义：有效新图必须走图领域入口，不能通过通用对象入口绕过授权；仅改旧图版本号不能静默升级。

全工作区类型检查与构建通过。图、扩展数据、运行证明测试和合成浏览器结果见 `D:/AI/DeepSeekHarness-Plugin/artifacts/graph-theme-vertical-20260915/logs` 与 `browser-verification.json`。真实安装回执随后保存于同目录；本报告不把打包视为已安装。
