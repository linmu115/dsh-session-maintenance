# ThoughtDAG UI 对齐兼容

本批将 ThoughtDAG 精确兼容白名单扩展到 `0.4.14-rc2.10`，配套 Engine `0.1.33-rc2.23` 和 Maintenance 插件 `0.2.26-rc2.19`。同时更新 Launcher 插件发现和 Engine 运行证明的版本清单，使副本在升级后仍能按既有证明流程接入。

ThoughtDAG 本批改动集中于会话页与思维图的边框对齐、视图切换动效和画布交互细节。Maintenance 不改变对象结构、会话归属、固定版本与截止位置、上下文预算或存储方式；数据库保持 schema 24。现有会话标题持久化修复继续保留。

部署范围为 19 个 DSH 插件中只替换 ThoughtDAG 和 Maintenance 两个包，其他 17 个包复用上一批精确归档。6 个扩展命名空间与 writerId 保持；仅 thoughtdag 的接入版本更新至 .10。既有图结构不执行数据迁移。

验证包括当前 6 个命名空间均为 ready、未知版本仍拒绝，以及 Launcher 发现、运行证明与扩展持久化回归。运行副本验收将在实际安装后单独记录，源码升级不代表已发布公共安装包。

合成验收结果：extension-data、v3-runtime-attestation、integration-api 共 24 项通过；完整 workspace build 和 git diff --check 通过。测试不读写真实 Vault，不发模型请求。
