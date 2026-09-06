# Maintenance 0.1.16 / 插件 0.2.18 候选交付验证

日期：2026-09-06。本批实现用户选定的 SM-05、SM-06 局部拆分、SM-07、SM-08、SM-09、SM-11 和 SM-13。

## 来源与使用状态

- Maintenance 打包源码：`f2b3c163477e0e2780c763eda25d8a8219592983`，打包时工作树干净；Engine 0.1.16 / 插件 0.2.18 / schema 20。
- 已有基线 `0dbf921` 及 RC1 `37c1bfe` 修复保留；SCM 使用已发布的 0.3.2。
- Launcher 独立提交依次为 `7b9dc67aefe1bc4f96c6e55b6ca23ebdd516a8c3`、`47b2d5da6b46d169916c3353ada3680a245e5107`，版本标识仍为 0.2.2。
- 候选目录：`D:/AI/DSH-Plugin-Releases/maintenance/candidate-0.1.16-0.2.18-20260906`。来源、摘要、测试及部署状态同时记录在该目录的 `candidate-manifest.json`。
- 当前在用仍是 Engine 0.1.15 / Maintenance 0.2.17 / SCM 0.3.2 与原 Launcher；本批未替换它们，也未执行真实数据隔离或释放。

## 最终源码与包校验

| 检查 | 结果 |
| --- | --- |
| 最终完整测试 | 172 文件、541 项全部通过，302.08 秒；单 worker，单项超时 30 秒 |
| 最终全仓构建 / 类型检查 | 均通过 |
| 最终缓存、治理及 API 聚焦组合 | 5 文件 26 项通过；已包含在完整测试内，不重复累计 |
| SCM 0.3.2 宿主 | 34 项通过；Maintenance 消费侧包含在完整测试中 |
| 可移植归档 | 29 个归档文件检查通过；源码、版本、协议、锁文件、摘要与独立 Adapter worker 对齐 |
| 看板真实包入口 | 默认路径发现、无关工作目录启动、页面/脚本、一次性登录码、会话鉴权与正常退出均通过 |
| 原数据库副本升级 | schema 17 → 20；稳定业务行及已有历史元数据逐组摘要完全一致；第二次打开仍一致 |
| Launcher | Windows GNU 独立 Hook 21 项、GUI 关联 Hook 18 项、process 8 项、收尾补测 1 项和示例 1 项通过；有交叉用例，不累加为不同测试总数；Clippy、前端、release 和补丁重放通过 |

完整测试日志为 `.artifacts/selected-candidate-final-full-tests.log`，构建与类型日志为同目录的 `selected-candidate-final-build.log`、`selected-candidate-final-typecheck.log`。候选目录 `validation/` 保存对应证据副本。Launcher 具体命令、限制和摘要见候选目录内的 `docs/changes/SM-13.md`。界面人工验收及跨平台 CI 不在此次自动验证内。

## 升级不变量

输入数据库仅以只读方式创建 SQLite 一致性备份；实际迁移与再次打开均在有标记的临时目录进行。未复制原配置、连接凭据或 home 注册，未读取正文对象。此项证明元数据升级保持性，不等同于重新验证每个正文文件。

| 不变量 | 保持的行数 |
| --- | --- |
| logical_sessions | 520 |
| session_versions | 5634 |
| version_parents | 5131 |
| canonical_events | 245189 |
| session_derivations | 16 |
| checkpoints | 51 |

已有历史元数据共 5634 行，availability 分组和未知保存时间数量均保持不变。详细摘要见候选 `validation/selected-candidate-upgrade.log`。

## 存储与验收边界

普通完成运行保留至少 48 小时，完成恢复证据至少 120 小时，每组保留最近 3 份有效自动备份，可重建缓存目标 1 GiB，隔离宽限期 48 小时。活动、引用、固定与未知状态优先保护。缓存以登记和已验证的刷新时间排序，纯读取命中不单独记账。缓存重建可建立新代际，旧恢复不覆盖新缓存。

所有既有历史版本正文继续受保护；SM-10 五天历史裁剪、SM-12 正文分块迁移和自动清理定时器均未启用。副本治理先预览，再显式隔离、恢复或宽限后释放。候选需要分别人工验收统一菜单目标、看板、导入取消/重试、运行收尾，以及专用测试目录中的隔离恢复。

最终证据文档会以单独的文档提交补充在打包源码之后；这一提交不改变包内代码。保持主工作树、旧部署和整套回退材料，避免覆盖其他任务的工作。
