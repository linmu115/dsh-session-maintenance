---
id: HIST-learning-association-repair
kind: history
title: 学习关联修复与普通同步自动排除
date: 2026-09-19
status: current
modules:
- 运行时投影
- 看板
- Codex 适配
- 版本存储
outcome: .53 已部署，真实关联和零增量交接成功，新增问答往返待验收
summary: 修复有效历史提取、普通同步冲突及零增量预算误拦截，保留真实历史与派生数量。
applicability: DSH RC2、Codex CLI 0.153.4 legacy/paginated 学习问答；交接前停止 DSH，新增内容送达后重启 Codex。
coverage_note: 索引当前任务第 1194–1866 行公开消息与工具结果；覆盖关联与交接修复，后续引擎重启及推送另见交付报告。
history:
  path: history/20260919-learning-association-final
  sha256: 8fb4593623f5a592fd2c73be54afaca2c0c4cd9acb855bbba87ca81c4fcd3635
  capture_sha256: 755e55d8ca5704220c877e1b2afcae45167d447bba24ab6b882370f57a77e650
related_records:
- REQ-learning-roundtrip
- MOD-learning
- HIST-learning-roundtrip-implementation
---

# 学习关联修复与普通同步自动排除

用户追问共同前缀校验失败如何处理。对照普通导入发现，两端有效历史实际为 49 条一致；学习路径却混入压缩前历史，遗漏公开进度，并保留了批注等消息封装。复用有效历史和可见用户正文提取后，关联成功。图片仅在学习文字核对中跳过，原始历史保持不变。

[查看依据：共同前缀失败后的处理要求](history-event:EVT-cbdfeac4b48b85709e72)

用户要求双向维护会话自动解除普通同步，避免产生大量派生。绑定事务同步排除普通 Codex 同步，扫描、启动名单、清理保护及旧计划执行均尊重学习归属；停用学习绑定后不会自动恢复普通同步。本次真实目标派生数始终保持 25，未删除既有派生。

[查看依据：自动解除普通同步](history-event:EVT-fc6b235f1511e0e6dc0d)

.51 完成关联修复；随后用户报告“同步到 Codex”点击没有反应。检查发现零增量交接错误地用全部历史进行预算检查，错误提示位置也不明显。.52 增加零增量交接回执并在操作旁展示错误；真实点击后状态成为 sent，Codex 原日志未写入。进一步检查后，.53 将非零增量预算同样限定为实际新增内容。

[查看依据：点击同步无响应](history-event:EVT-eb85c480b0a78178f75a)

用户询问新增内容同步后是否直接跳转。当前按钮执行已绑定会话的增量交接，保存回执；不自动跳转、不自动启动模型。新增独立会话需要分别建立关联。新增正文送达后需重新加载 Codex 才能继续使用新上下文。

[查看依据：新增内容与跳转行为](history-event:EVT-09a4cd8a8af54cd385fa)

本轮相关测试去重 71 项通过；其中一次既有计时测试超出默认 5 秒上限，单独放宽测试上限后通过。最终 .53 发行检查 32 项、portable 43 文件通过。真实 CLI 配合本机固定响应服务验证 legacy/paginated 注入与下一轮上下文，未调用真实模型。真实新增问题与回答的完整往返仍未验收。

代码提交 af2c5c7。实现与验收边界见 [旧记录 IMP-learning-roundtrip](https://github.com/linmu115/dsh-session-maintenance/blob/d3fdbe3c5a3a031f37bf4f741819e1ba2833202f/docs/project/records/implementation/learning-roundtrip.md)、[旧记录 VER-learning-roundtrip](https://github.com/linmu115/dsh-session-maintenance/blob/d3fdbe3c5a3a031f37bf4f741819e1ba2833202f/docs/project/records/verification/learning-roundtrip.md)；详细证据见 [修复报告](../../../reports/2026-09-19-learning-prefix-and-sync.md)。后续用户要求的重启与版本控制交付见 [重启与推送报告](../../../reports/2026-09-19-learning-restart-and-push.md)，该后续过程不属于本记录来源索引的覆盖范围。
