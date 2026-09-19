---
id: HIST-maintenance-source-list
kind: history
title: 真源同步名单折叠与选择布局
status: current
date: 2026-09-19
summary: 按用户截图将 Maintenance 真源名单默认折叠，展开采用 Codex 名单布局。
outcome: 源码与合成验证完成，后续随Engine .45安装；安装版UI未验收。
applicability: 当前地图登记工作树的 Dashboard 真源同步面板。
coverage_note: Codex 根据本次用户请求、代码检查和合成测试整理，索引当前任务第9至163行，54条公开事件，截点处1条调用未配对；图片仅以用户描述及本轮视觉检查补充。
history:
  path: history/maintenance-source-list-20260919
  sha256: 7974858ce44ca26c5b2681df246e6d648db4538bf8a868e2a39deef04c360136
  capture_sha256: d3ff24d927f0e4173013ec3ae808f79d6045673f855ca28de24b8c4009f31e31
related_records: [REQ-maintenance-source-list, MOD-dashboard]
---

# 问题与处理

由 Codex 在 2026-09-19 根据当前任务用户文字及三张截图整理。用户认可实例选择，要求同步范围模仿 Codex 映射名单，默认折叠、三角形展开，选择 Maintenance 自己的真源名单。

旧界面将单选同步模式、简化工作区列表和底部编辑行直接铺开。现在以 Maintenance 真源名单收拢，折叠时仅显示已保存数量/全量模式、待生效和未保存提示；展开后展示搜索、已选计数、工作区勾选及详情。全部模式下取消某一项自动转为显式名单，保留其余项目及未分组选择。保存沿用实例 ID、expectedRevision 和下次启动生效规则。

浏览器初次验收发现模式选项占用过高，720 像素高窗口首屏名单不可见；随后将模式选项压缩为同行展示，复核首条可见、名单滚动与底部操作区。保存后长名单摘要会占高，改为数量摘要；详情仍保留于运行详情和名单。

# 验证与边界

16 项针对性测试、Dashboard 类型检查和构建通过。真实浏览器仅连接合成 fixture，检查默认折叠、展开、搜索、取消第18项后仍已选17项、收起/重开保持草稿、保存成功及下次启动提示。没有修改真实用户名单、Vault 绑定或历史。

当前安装来自独立 startup-recovery 分支，本轮仅修改地图登记的工作树，尚未进行生产包安装及真实实例 UI 验收。变更报告：docs/changes/2026-09-19-maintenance-source-list.md。

# 同一任务后续反馈：扩展栏目缓慢与缺项

用户继续报告本地扩展栏目长时间读取、GPT与ThoughtDAG入口不见。2026-09-19读取当前安装包和真实接口发现：安装版仍把所有扩展读取排在GPT索引刷新后，首次名单请求24.946秒，业务信息页93毫秒；后续名单返回三组ready，数据与适配器仍存在。工作树d273281修复未进入当前安装。8项针对性回归通过。停机预检发现1个托管运行，未停止、部署或改用户数据；运行版问题尚未修复。

这里是上方第9至163行索引截点之后的补充，不声称已纳入该索引。完整方法、纠正10秒超时误归因及证据边界见 [本轮诊断](../../../changes/2026-09-19-extension-loading-diagnosis.md)。

# 后续激活

同一任务授权安装后，以上真源名单与扩展导航修复已进入Engine .45 / Dashboard .1.7。此前首次24.946秒的扩展目录请求在新版单次检查为6毫秒，返回三个业务栏目。此为单次接口测量，安装版UI未验收；来源、停止回执及保留范围见 [[HIST-offline-vault-binding]] 与 [激活报告](../../../reports/2026-09-19-engine45-binding-activation.md)。
