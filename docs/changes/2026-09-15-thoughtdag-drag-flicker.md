# ThoughtDAG 拖动闪烁修复的兼容登记

Engine 0.1.33-rc2.24 / Maintenance 插件 0.2.26-rc2.20 将 ThoughtDAG 0.4.14-rc2.11 加入精确兼容清单，并更新 Launcher 发现与运行证明允许版本。旧允许版本继续保留，未知版本仍拒绝。

ThoughtDAG 修复拖动时丢失节点测量信息导致的隐藏重测。宽高缓存仅属于画布运行状态，Maintenance 保存的节点结构、对象归属、引用权限和固定截止位置均不改变。数据库保持 schema 24，无结构或用户数据迁移。

本批运行副本仅升级 ThoughtDAG 和 Maintenance 两个插件及匹配 Engine；其余 17 个插件保留原归档，六个扩展 namespace 身份与 writerId 保持。测试覆盖六类扩展接入、运行证明与 Launcher 集成；部署核验使用本批全新回执。

完整工作区构建通过。24 项相关测试首次并行运行时 23 项通过、1 项超过默认 5 秒；超时项单独按原超时设置重跑通过（约 295ms），没有放宽断言或修改业务实现。

## 副本交付结果

已安装并通过 Launcher 重新启动 0.1.5-rc.2 副本 web。构建源码为 ThoughtDAG `82410841dc107479cb6934688820f6f670e11c58`、Maintenance `9877f4e`；本节为打包后的文档补充，不改变归档来源。

- 19 个精确包的合成宿主写入与冷读取探测通过；实际 88 个运行文件和 ThoughtDAG 4 个 HTTP 资产与归档一致。
- 六个扩展命名空间全部 ready，原生上下文状态、用户请求目录与范围隔离检查通过；仅 thoughtdag 接入版本变化。
- schema 保持 24；停止后基准包含 534 个 head、251,711 条规范事件，交接及启动后的规范正文、版本、父关系和元数据摘要均一致。主实例配置和引用存储未改变。
- 可引用目录 40 个目标均与原生标题匹配，持久标题恢复证明通过。3 条旧目录名与原生名不同，继续由原生名称优先规则处理。
- ThoughtDAG 49 项测试、17 项合成浏览器主流程通过。真实窗口未做代替用户的拖动操作；在线验证证明副本已加载同一修复包。

当前退出使用插件认证接口，官方生命周期结算为 recovered/finalized，无手动改写运行状态或向 DSH 发强制终止信号。本次未发真实模型调用或改动真实图、引用和 Vault 正文。

本地证据目录为 `D:/AI/DeepSeekHarness-Plugin/artifacts/graph-drag-flicker-20260915`，包括 `validation.json`、`graph-assets.json`、`live-titles-after-drag.json`、`host-probe/result-final.json` 及构建／测试日志。回滚副本、机器配置和运行凭证不上传。
