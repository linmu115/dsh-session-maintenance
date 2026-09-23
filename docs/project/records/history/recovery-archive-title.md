---
id: HIST-recovery-archive-title
kind: history
title: 重启重复会话、归档复现与旧派生标题的修复过程
date: 2026-09-17
status: current
modules:
- Harness 适配
- 运行时投影
- 宿主接入
outcome: 已部署到 RC2 副本，第二次重启无新增会话身份，四份重复项保持归档
summary: 从归档后重复出现和点击改名的反馈，定位准备尾部恢复、归档投影与旧派生标题三个问题，修复并验证历史前缀不变。
applicability: DSH 0.1.5-rc.2 副本 / web；Engine 0.1.33-rc2.31、插件 0.2.26-rc2.25、Adapter 0.1.4。
coverage_note: Codex 于 2026-09-17 整理；绑定本任务从重复会话反馈到修复交付的公开来源第 127–735 行。未收录此前贴纸诊断及后续删除用法问答；图片和隐藏推理不进入索引。
history:
  path: history/20260917-recovery-archive-title
  sha256: dfbdb38c1b3ae28365765c38b34a1968ab030a39d6eb00c00cb623b732ca79a8
  capture_sha256: f3b10fe6477eca6747428146c77dc54d81f6dcc503f0eb422c5ce2871a28d5fd
related_records:
- MOD-runtime
- MOD-codex
---

# 重启重复会话、归档复现与旧派生标题的修复过程

## 问题与诊断

用户报告“机试DeepLearning”经官方归档后重启仍出现重复条目，点击后标题变成工作区名称，随后明确要求执行修复。此次维护以稳定身份和事件内容核对为准，没有按相同标题合并或删除历史。

[查看依据：用户报告归档复现与点击改名](history-event:EVT-73b9ed1f04f57271ac73)

只读检查发现：已有 WAL 恢复过滤没有覆盖新扫描的纯准备事件尾部，因此恢复会额外创建派生身份；投影目录未传递 archivedAt，宿主启动无法还原 canonical 的归档意图；三个旧派生原生日志缺少标题事件。三个现象分别处理，不能将同名条目全部视为同一个会话。

## 修复与尝试

Adapter 在验证头与已提交前缀后忽略纯准备尾部，含真实事件的混合尾部完整保留。目录携带归档时间，宿主通过官方 archiveSession 恢复正向归档意图，空标记不撤销用户归档。旧派生标题通过官方 rename 追加，避免重排历史事件序号。源码提交 dec850f。

完整构建暴露 GPT 扩展导出类型依赖私有路径，改用宿主 Adapter 的显式公开类型。发布首次接入因兼容清单缺少新版本而拒绝；补齐 Engine 与插件清单、完成接入及回执回归后重新打包安装，提交 026a749，没有绕过校验。初次可重复构建验证的输出参数不受脚本支持，最终路径检查失败，改为显式核对三份构件及内嵌插件。

旧引擎最后一次收尾又创建一份纯准备派生项，最终处理四份。官方 rename 返回早于文件刷盘，初次即时检查未见标题事件；随后等待刷盘并按已保存计划续跑。四份重复项均验证继承前缀与固定基础版本一致，执行官方归档，保留正文和身份。

## 结果与边界

174 项相关回归、受影响类型检查及完整构建通过。部署后第二次正常重启无新增会话身份；四份派生项在 canonical 和宿主均保持归档，标题冷读取正确，原始镜像唯一可见。升级前 252,172 条 canonical 事件保持不变，1072 项受保护文件指纹不变，七个业务命名空间 ready，数据库检查通过。部署验收记录提交 b801e0b。

详细版本、失败条件与验证范围见 [修复报告](../../../reports/2026-09-17-recovery-archive-title.md)，当前实现见 [旧记录 IMP-recovery-archive](https://github.com/linmu115/dsh-session-maintenance/blob/d3fdbe3c5a3a031f37bf4f741819e1ba2833202f/docs/project/records/implementation/IMP-recovery-archive.md)。此次实际验收覆盖官方接口与文件冷读取，没有声称人工 UI 验收；未调用模型，未删除会话历史，也未修复此前贴纸挂接问题。来源索引只保留公开事件定位与指纹，私有数据库、原生正文及备份不随代码发布。
