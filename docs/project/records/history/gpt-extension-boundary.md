---
id: HIST-gpt-extension-boundary
kind: history
title: 将 GPT 插件误当成 Harness 的纠正过程
date: 2026-09-17
status: current
modules:
- Harness 适配
- 扩展数据
outcome: 已纠正并部署到副本；原会话恢复与扩展索引验证通过
summary: 曾把新增持久化事件误判为新 Harness，用户指出栏目与职责错位后，改为宿主 Adapter 加插件扩展解析和索引。
applicability: DSH 0.1.5-rc.2，GPT 插件 0.5.0-dev.3，Maintenance Engine rc2.29 到 rc2.30。
coverage_note: Codex 于 2026-09-17 整理；涵盖本任务的独立适配要求、此前实现发布、栏目反馈和明确纠正；仅收录公开事件定位，不复制原会话载荷。
history:
  path: history/20260917-gpt-adapter-boundary
  sha256: 42aad09710eae88272bf489891f45fb8a870a928c36a207a6089492926ec3f63
  capture_sha256: 9b5a8054736509463cd8a6ba664958347e803cdc380d14c6162e5071a910869b
related_records:
- MOD-plugin-adapters
- IF-plugin-data
- IF-endpoint-sync
- IMP-current-source
---

# 将 GPT 插件误当成 Harness 的纠正过程

整理者：Codex，2026-09-17。范围是本任务的插件接入设计、实现和纠正；此前整个 GPT 项目和其它任务没有全部收录。

## 问题与第一次判断

用户要求兼容其它插件的会话格式时先构建 Adapter，避免直接改通用代码。我把 GPT 新增检查点、压缩和请求投影事件理解成了新的 Harness 格式，进而新建 `dsh-gpt-compat` Harness ID、formatId、worker，并让副本绑定到它。这是我对 Adapter 所属层次的误解；用户没有要求把插件变成另一种宿主。

## 尝试与实际反馈

第一次实现把插件事件解析从全局依赖替换中拆出，完成了事件往返、恢复、发布和回执验证，源码提交为 bb92f97。随后生成 Engine rc2.29 / 插件 rc2.23，部署记录为 f0aa7b0。这些测试说明被实现的格式能够工作，不能说明 Harness 与扩展数据的职责分配符合用户设计。

用户在扩展数据栏目找不到 GPT Adapter。我最初仍按两类 Adapter 的既有实现解释入口，未及时发现实现本身选错了类别。之后用户明确指出：高级设置的 Adapter 适配 Harness 实例的会话迁移，GPT 插件属于扩展数据。

[查看依据：用户明确区分 Harness 和插件扩展](history-event:EVT-96198d5cd1afe2bb9617)

## 转折与纠正

我承认把“新增持久化事件”推导成“新增 Harness”是错误判断，撤销该设计。正确拆分是宿主保留 `dsh-0.1.5`，插件拥有独立 ExtensionDataAdapter、精确事件校验和按会话归属的只读索引。必需重放载荷仍完整保存在会话链路；索引不复制加密正文。

[查看依据：确认误解并承诺纠正](history-event:EVT-b7e27085c9f25d771ecf)

## 结果与边界

当前接口规则见 [旧记录 IF-extension](https://github.com/linmu115/dsh-session-maintenance/blob/d3fdbe3c5a3a031f37bf4f741819e1ba2833202f/docs/project/records/modules/adapters/business/contract.md) 与 [旧记录 IF-harness-adapter](https://github.com/linmu115/dsh-session-maintenance/blob/d3fdbe3c5a3a031f37bf4f741819e1ba2833202f/docs/project/records/modules/adapters/harness/contract.md)，实现见 [旧记录 INT-gpt-format](https://github.com/linmu115/dsh-session-maintenance/blob/d3fdbe3c5a3a031f37bf4f741819e1ba2833202f/docs/project/records/modules/adapters/business/gpt-compat.md)。聚焦验证覆盖高级 Harness 列表中无 GPT 条目、扩展数据面板实际注册、原始事件往返、历史身份兼容读取、Core 绑定、启停和实例隔离。副本已安装 rc2.30 / rc2.24 并启动，Harness 为 dsh-0.1.5，扩展数据出现 GPT 兼容插件，现有 1 个会话索引；50 个会话可读，旧验收事件前缀保持一致。完整副本升级与运行结果写入 `docs/reports/2026-09-17-gpt-extension-boundary.md`，不能用源码测试代替部署证据。

旧提交、旧 run、来源事件身份和当时的报告保留；不修改历史使其看似从未出错。当前地图取消“新增插件事件必须创建 Harness Adapter”的规则。后续接入先判断被适配对象是宿主实例还是插件数据，并把栏目、注册表和身份断言加入验证。
