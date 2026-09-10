# 持久原生会话与插件扩展数据：规格交付

日期：2026-09-10。状态：仅文档，待用户评审。

## 交付

- [RC1 持久原生会话空间规格](../superpowers/specs/2026-09-10-persistent-native-session-space.md)：描述现状与目标差异、Module/Interface 职责、空间身份、建议目录布局、增量同步、崩溃恢复、运行协议与 13 项后续验收场景。
- [可拔插插件数据需求](../superpowers/specs/2026-09-10-pluggable-extension-data-requirements.md)：区分会话与扩展对象真源、两类 Adapter、稳定引用、启停与面板、数据保留和暂不实施上下文快照的范围。
- 已核实 ThoughtDAG fork 为 `linmu115/thoughtdag`，父仓库为 `chenxiachan/thoughtdag`。

## 核对

依据基线 `866f6b6` 的缓存、运行目录分配、启动补丁、原生补齐、事件提交与退出恢复代码核对现状；所有新行为和验收项均为设计要求，不表述为已实现。

本次检查文档引用、验收编号、暂存差异和空白格式。没有可执行代码变更，因此不新增或运行行为测试；文档内 N01–N13 是实现后的验收要求。

## 实施状态

用户要求先提交文档并提供链接，实施和副本部署暂缓。没有修改运行代码、发布版本、Launcher/DSH 配置或真实会话数据。
