---
id: OBJ-version
kind: object
title: 不可变版本、来源谱系与回执
status: current
summary: 规范版本记录会话内容和来源，谱系与检查点保存派生和恢复边界，物理投放另有回执。
---
追加、导入、墓碑和派生创建可追溯版本；来源证明、端点 epoch、绑定代次与作业回执分别描述不同边界。一个版本存在并不说明它已进入每个宿主，失败投放保留真源和重试位置。Codex 续接必须固定来源版本，学习回收还需未消费交接回执。实现 [[MOD-core]]、[[MOD-continuation]]、[[MOD-runtime]]。
