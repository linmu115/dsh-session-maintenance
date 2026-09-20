# Maintenance 问题登记：插件自由组合与未知数据保留

状态：已登记，暂缓实现。用户要求先关闭引擎，验收其他插件的独立使用。

## 已确认问题 MNT-001：普通插件变化导致受管实例无法启动

触发：已注册实例安装 DSH Bridge，安装回执重新生成通过，managed-instance check 后仍为 needs-attention。
原因：实例适配层将 extraBundles、配置 patch 等整体计入 fingerprint，启动绑定要求它与注册记录完全相同。
check 只验证并返回状态，不更新绑定；register 拒绝已注册实例。
已验证：Engine .58 / 接入 .36，Core .21、DAG .17；安装 Bridge .4 后复现。

最新用户边界替代此前“任何插件变化后手工 revalidate”的方案：
- 普通业务插件增删升级，不得仅因此阻止实例启动，不要求 Maintenance 逐个登记。
- 自动检查真实必要接入条件：实例身份、Maintenance 接入协议、宿主持久化与会话格式能力。
- 只有具体核心合同不兼容才限制受影响操作，错误须指出实际条件。
- revalidate 最多是诊断/核心接入变化的修复工具，不是日常安装插件的前置步骤。

定位：packages/instance-integration-dsh/src/launcher-discovery.ts；apps/engine/src/integrations/service.ts、runtime-binding.ts、standalone.ts。

## 待核查问题 MNT-002：未知会话数据是否能无损往返

这是已确认的目标、尚未完成的代码审计与验收，不宣称当前必然丢数据或已经支持。
宿主接受的未知上下文/扩展类型，应原样保留类型、内容、顺序、身份、必要关联、附件引用、修订和删除状态。
业务 adapter 增加展示、检索、编辑或转换能力，不是获准保存数据的名单。
缺少 adapter 不得丢弃、降格为普通文本或恢复时静默省略。
保留数据不等于执行第三方插件；私有外部数据库需经正式端口接入，不自动扫描或猜测。

后续核查 normalization、canonical store、materialization、扩展 schema 校验、备份恢复、同步恢复、未知附件等全链路。必须用合成未知类型验证导入—维护—恢复往返。

## 当前不做

不删除启动保护来绕过；不添加逐业务插件名单；不实现新的 revalidate 命令；不改未知类型转换链；不继续扩大 Maintenance 开发。正常解除测试实例注册后转独立模式，保留维护历史。
