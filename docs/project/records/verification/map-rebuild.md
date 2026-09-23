---
id: VER-map-rebuild
kind: verification
title: 2026-09-23 项目地图交付检查
status: current
date: 2026-09-23
summary: 62 条记录结构有效；三类图机械条件就绪，已在 HTML 实测节点与文档跳转；产品运行验收不在本次范围。
relations:
  - relation: verifies
    to: {record_id: IMP-current-source}
    reason: 地图说明与绑定源码的责任边界核对
---
本轮检查对象是地图、当前仓库源码和本地 HTML 阅读页，不是 DSH 实例或 Maintenance 发行安装。项目 ID 保持原值。重构前保留 [覆盖清单](../../migration/coverage-before-20260923.json)，其中新地图 19 条、旧修订 103 条；[逐条去向](../../migration/disposition-20260923.json)分为保留 31、合并 22、用户撤销 1、历史定位 49。七条旧需求逐项核对，其中“实例新建工作区自动登记”被明确撤销，其余按后续用户要求重写；旧历史测试没有被提升为当前运行结论。

- `project_map.py validate`：62 条记录，`valid: true`，0 errors / 0 warnings。检查只覆盖地图声明的来源与自有记录。
- `check_map_delivery.py` 完整模式：`structural_valid: true`、`mechanical_ready: true`、`delivery_complete: null`（脚本只说明机械前提，不替代人工内容判断）。Archify 架构图 15 节点、流程图 31 节点，原生 schema/连线校验均通过；架构图仍有一处连接交叉和桌面全图文字偏小警告，流程图有全图文字偏小警告，可在阅读页放大节点。
- GitNexus 显式选择 577 个生产 TypeScript/TSX 文件，来源指纹 `9a8373099af876dfa05099e25cd54f231a11165ec3e362466caf2dcbab44ef35` 为 current。原生快照含 17311 节点、44496 关系，其中直接 `CALLS` 7562、`IMPORTS` 1091；页面提供 869 条预算内调用链。19 条悬空关系保留为覆盖限制，动态注册、跨进程 RPC 和同名回退不被当成运行轨迹。包清单与代码图均覆盖 Engine、Dashboard、DSH 插件、Codex、Lynn/GPT、规范存储和宿主适配；入口函数 `EndpointSyncCoordinator`、`createComposition` 已按源码和分析结果抽查。
- HTML 已正常导出并在本机浏览器实际打开：整体图聚焦“端点同步协调”后出现关联模块与接口，点击“端点同步协调”进入 `MOD-endpoint`；流程图聚焦“宿主独占写入”后出现 `IF-host-writeback`、`MOD-dsh-host` 及阻塞分支；模块图显示 577 文件、函数、调用链，`createComposition` 可展开原生关系、依据及关联说明，分析限制在页面可见。模块图较大（约 30 MB），首次载入可能需要稍等。

此次没有启动或写入用户实例，没有做同步、插件功能往返、真实 UI 视觉或发行构件验收。历史产品测试继续按 [[VER-sync-20260922]]、[[VER-host-20260922]] 的日期和条件阅读。旧地图中外部来源的历史条款若与后续用户决定冲突，以 [[DEC-sync-authority]] 和当前需求为准。
