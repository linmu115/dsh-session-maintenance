# 2026-09-13：V3 投影身份解析与实例缓存作用域

## 问题与修复

RC2 副本在启动准备阶段返回 `Adapter did not resolve native identity`。V3 Adapter 的身份解析要求读取已经生成的投影，并核对逻辑会话、原生文件 Header、实例及 Profile；Lifecycle 和持久化缓存调用该接口时漏传 `ProjectionReader`。缓存第一次构建还在写出投影前尝试解析身份，导致没有可验证的对象。

本次修复保留 V3 Adapter 的严格校验，在三个调用路径传入对应的投影目录：普通 Lifecycle 准备、持久化缓存初次构建、缓存增量更新。初次构建先成功完成 materialize，再从实际生成的目录解析每个会话身份。

同时，Lifecycle 提供的缓存配置从仅包含分支，调整为包含分支、实例 ID 和 Profile ID。V3 投影记录本身归属于实例及 Profile；不同实例或 Profile 现在各自保存并复用缓存，同一实例同一 Profile 的后续启动继续复用同一缓存。恢复过程使用一致的作用域配置来核对缓存路径。

## 边界

- 不把“缺少 reader”降级为直接根据逻辑 ID 猜测原生 ID。
- 不放松 Adapter 对 Header、实例或 Profile 的校验。
- 不从别的实例缓存获取或覆盖当前实例历史。
- 不改写真实会话、不删除旧缓存、不自动把旧的无实例作用域缓存认作新的实例缓存。
- 未读取导致失败的真实会话正文；根因通过调用路径与 Adapter 契约即可确认。

本修复属于 Engine `0.1.33-rc2.3` 发布。实例启动、恢复 Header 的其它修复和最终部署验证由同一发布流程独立记录。

## 验证

新增测试直接使用实际 V3 Adapter，在带标记的合成目录中覆盖：

1. 非缓存 Lifecycle 成功准备，并确认缺 reader 仍然拒绝、正确 reader 可以解析。
2. 缓存初次构建与增量更新在投影存在后解析；新增会话能解析，错误实例作用域仍被拒绝。
3. 两个实例及两个 Profile 的缓存互相隔离，回到同一实例和 Profile 后复用原缓存。

现有缓存 Lifecycle 测试同步使用完整缓存作用域，保留跨运行复用、增量写入和恢复路径检查。

执行了 `v3-reference-reader`、`persistent-cache`、`persistent-lifecycle` 和 `open-run` 四组回归测试，以及 Projection Lifecycle 包的类型检查；全部通过。原始测试输出保存在发布目录 `validation/v3-projection-identity/`。
