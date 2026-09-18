# DSH 实例分类工作区同步与桥接维护接线

用户确认本轮直接施工；同步范围指 Maintenance 自己的会话分类工作区，保存后在实例下次启动时生效。普通贴纸继续拥有笔记关联业务，Bridge 管理绑定与路由，Maintenance 通过可选能力提供范围与信息页。

## 运行行为

- 每个稳定实例单独保存选择和 CAS 修订。未配置默认全部；显式空选择表示不投影会话；未分类会话单独可选。实例的各运行 Profile 与 Vault 复用同一份选择。
- 投影前把当时的策略冻结为运行快照。新的设置不截断当前会话保存，关闭与异常恢复继续采用该运行快照，下一次启动采用新设置。升级前尚未关闭的运行按原来的全部范围恢复。
- 完整与增量投影都先按分类筛选，再加载会话正文。范围修订参与缓存身份；取消范围只影响派生实例数据，不删除真源历史。重新选择保留原逻辑会话身份。
- 回写在写正文前和 Canonical 事务内分别复核有效策略、当前成员归属与删除状态，失败时不写会话头或成功回执。事务外先写入的不可变对象不等于已提交会话。
- 实例目录接纳受信配置中的 DSH 实例以及 Launcher 已准备运行的稳定实例。可用性区分 available、not-synced、offline、mapping-pending、deleted、not-found。
- schema 26 保存实例选择，schema 27 保存运行范围。静态恢复点与保留策略兼容这两个新版本，仍拒绝未知格式并核验外键。

## 可选宿主与业务页

Engine 组合根接入实例配置、有效范围和会话状态路由，统一鉴权、Origin 与 CSRF 检查保持。受信宿主提供固定身份的 `maintenanceInstanceWorkspace`，只在已成功接入的管理运行上公布 `maintenanceInstanceIdentity`。同源 knowledge API 转发 `session-availability` 和 `workspace-scope`，不向浏览器暴露 Engine 凭据。

公共 `maintenanceBusinessPages` 独立于托管会话初始化注册，未注册贡献者不发网络请求。公开贡献者通过声明式栏目和受限动作使用 Engine 队列；Bridge 的绑定动作仍调用 Companion 的唯一 CAS 写入口。具体贡献接口见 [公共信息页记录](2026-09-18-public-business-pages.md)。

现有数据 Adapter 的已验兼容名单补充 Core `0.3.12-rc2.19`、Sticker `0.7.4-rc2.1/.2`、Companion `0.6.4-rc2.7 / 0.7.0-rc2.1`。未降低 schema、writer 或受管数据归属检查。

普通贴纸待删除回链继续保存于原迁移回执。`updateBacklinkDelete` 在修订核验后更新剩余 Vault，已有目标只能缩减，不能改投新 Vault；空数组表示远端均完成、等待最终确认。其他 JSON 信息原样保留。

## 验证

- Store、Projection Lifecycle 全套，加 Runtime Broker 和实例范围运行测试：44 文件、164 项通过。
- 实际 HTTP 组合接线与原 HTTP API：2 文件、4 项通过。
- 宿主范围、knowledge API 与范围缓存聚焦：3 文件、11 项通过。
- 新候选版本组合的会话知识集成用例通过，覆盖迁移、部分删除回执、陈旧 CAS、拒绝改投、引用与会话隔离。修正该旧用例中与现有“禁止上下文循环”规则矛盾的场景，改以第三会话验证目标隔离，另保留明确拒绝循环的断言。
- Engine、Contracts、Store、Projection Lifecycle、Local Client、Dashboard 和 DSH 插件构建通过；构建后的 Engine 模块可正常导入。

以上组别可能交叠，不相加为一个总数。测试均使用合成数据、回环 HTTP 服务和临时目录；没有部署、重启用户实例或修改真实 Vault／会话。Dashboard 与宿主完整回归由独立验收记录补充。候选版本为 Engine `0.1.33-rc2.38`、DSH 维护插件 `0.2.26-rc2.29`。
