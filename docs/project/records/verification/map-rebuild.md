---
id: VER-map-rebuild
kind: verification
title: 2026-09-23 项目地图结构与来源检查
status: current
date: 2026-09-23
summary: 新地图结构校验通过，源码入口扫描、记录检索及阅读页导出成功；不代表产品运行验收。
relations:
  - relation: verifies
    to:
      record_id: IMP-current-source
    reason: 本次只核对实现说明引用的源码位置和责任边界
---
本次检查范围为仓库当前源码和新 `docs/project`。项目 ID 保持原值，记录分为要求、模块、接口、实现、问题、验证与时间日志；旧地图从当前 Git 树删除，保留 [旧 ID 定位](../../legacy-id-index.md) 和原提交的 Git 历史。仓库原有四处未提交文档改动不纳入此次提交。

- `project_map.py validate docs/project`：19 条记录，`valid: true`，0 errors，0 warnings。该检查覆盖已声明来源和地图自有记录，不递归验证外部项目。
- `project_map.py source ... --kind entrypoint --workspace source`：绑定的 Git 工作区扫描 1015 个文件；报告保留静态解析限制，不能从扫描直接推断动态调用或全部架构关系。
- 对关键插件适配记录的 `read` 返回三个源码位置均存在；“写入屏障”的受限检索可找到对应记录。人工也核对了端点协调、装配根、宿主写回、Lynn、GPT、Dashboard 和 DSH 插件入口。
- 原生 Archify 校验通过新架构图的 schema、连线及仓库来源；存在一项桌面缩放文字可读性警告。阅读页最终导出时包含此图；没有绘制流程图，也未做浏览器视觉检查。

本次没有启动或写入用户实例，没有做 UI、插件功能往返或当前发行包验收。历史产品测试仍按 [[VER-sync-20260922]]、[[VER-host-20260922]] 的日期和条件阅读。
