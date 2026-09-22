---
id: IMP-lynn-adapter
kind: implementation
title: Lynn 组合与独立 GPT 数据映射
status: current
summary: Maintenance 原样保留插件数据，Lynn 与 GPT adapter 负责真实插件握手、位置映射和正常回读。
progress: implemented
gap: Engine 与两个 adapter 包已升级；测试实例仍运行旧接入组件，等待正常停止后安装。真实连接未验收。
---

用户于 2026-09-22 确认：主体不建立插件业务模型，保留原数据与类型来源。插件缺席时不映射，未知结构保留且折叠。综合包名为 **Lynn adapter**，gpt-compat 保持独立。

Lynn 覆盖当前 Core .28、Bridge .10、Companion .8、Sticker .11、DAG .27 组合的会话数据。Core 聚合、会话扩展对象与本地贴纸恢复到原插件读取位置；图中原生会话身份、自动生成卡片和连线身份随目标重映射。Vault 文档与机器绑定维持原有归属，不自动复制或重绑定。

Engine 的图、引用、知识链接服务及路由迁到 adapter 目录。通用扩展服务只接收显示/刷新/目录策略接口。阅读器通过提供方接口接入宿主格式解释。裸核心不加载 Lynn 服务或路由。组合入口选择 adapter，旧导入路径只作兼容转发。

宿主写入屏障涵盖会话锁与插件写入队列；既有写入先排空，映射后从实际读取接口验证。采集后发生的插件编辑拒绝覆盖。未知插件扩展保留不投放。附属数据在 schema 29 持久存储，历史摘要和派生基准快照保持，缺失记录不代表删除。

GPT adapter 独立核验运行插件，恢复原始检查点/操作数据；过滤或派生后重排检查点和操作结果引用，正常宿主读回不一致时不报告成功。

实现与证据：[本轮报告](../../../changes/2026-09-22-lynn-and-gpt-adapters.md)。安装状态与真实连接验收不得由合成测试代替。

当前安装与保留证据：[Engine 部署回执](../../../changes/2026-09-22-lynn-engine-deployment.md)。
