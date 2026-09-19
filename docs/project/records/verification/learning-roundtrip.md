---
id: VER-learning-roundtrip
kind: verification
title: 学习交接闭环与 Codex 上下文验证
status: current
summary: 相关测试 71 项及发行检查通过；真实目标关联、历史不变和普通同步排除通过，真实新增问答往返未验收。
relations:
- relation: verifies
  to:
    record_id: IMP-learning-roundtrip
---

# 学习交接的当前验收结果

目标版本：Engine **0.1.33-rc2.53** / Dashboard **0.1.13**，修复提交 af2c5c7。本记录区分真实检查与隔离测试，不将健康检查等同于问答往返通过。

## 已完成的真实验收

- “机试DeepLearning”有效历史 49 条核对通过；正式浏览器“核对并加入”成功，双方各 2 张图片仅在文字核对中跳过。
- 普通 Codex 项目同步排除了该来源；原 canonical heads 不变、派生记录保持 25 条。
- 2026-09-19 18:11:12 点击“同步到 Codex”完成零增量交接：状态 ready → sent，回执 0 → 1；Codex 原始日志游标与摘要不变，未调用模型。
- .53 备份、正常退出、安装与接入校验完成；其他插件 1,165 个文件和原生历史校验保持一致。
- 2026-09-19 18:20:21 再次按用户要求重启引擎：旧 PID 48336 有 shutdown/drain/owner-release 完成回执，新 PID 43608 健康与目标接入 connected；学习仍为 sent、无阻塞。全部历史 head、学习绑定、交接回执与普通同步策略摘要一致，派生数仍为 25；DSH 保持停止。

## 隔离与构建验证

- 本轮相关回归去重 71 项，覆盖有效压缩历史、图片过滤、公开多条助手消息、前缀冲突、并发与回执事务、普通同步排除、启动名单、增量预算及界面错误位置。
- 一次既有 fake-timer 队列测试触发默认 5 秒测试上限，单独以 15 秒上限重跑通过（执行 530ms）；未改变业务超时，不声称全仓库全量通过。
- Engine/依赖构建、Dashboard 构建与类型检查通过；最终 .53 发行接入 32 项、portable 43 文件通过。
- 真实 CLI 0.153.4 使用临时 CODEX_HOME 和本机固定 Responses 服务，legacy/paginated 均确认注入持久化、重新加载、下一轮实际请求使用导入上下文及两条增量读取；真实模型调用 0 次。

## 未验收与证据

真实新增问答的完整往返、Codex 桌面重启后的学习体验、跨 DSH 实例重选、上下文替换未验收或未支持。既有派生会话未删除；本次重启没有产生新的同步、回收或模型请求。

详细测试命令、版本、归档摘要及现场证据范围见 [修复报告](../../../reports/2026-09-19-learning-prefix-and-sync.md)和 [重启与推送收尾](../../../reports/2026-09-19-learning-restart-and-push.md)。首版验证仍可从 [[HIST-learning-roundtrip-implementation]] 查看；本轮公开来源索引见 [[HIST-learning-association-repair]]。
