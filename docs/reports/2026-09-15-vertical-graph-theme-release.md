# 思维图上下布局与 DSH 主题发布

2026-09-15 已安装到 `0.1.5-rc.2 副本` 并通过 Launcher 正常重新启动。

## 行为

- 会话贴纸和跨会话引用自动产生的卡片，来源在上、接收会话在下，同一条链横坐标对齐。多来源在上方错开，前后端默认行距 260px。
- 已有手动坐标保留；需要整理旧图时，右键空白处使用“按来源排列”。右键指定的添加落点仍被尊重。
- 画布、卡片、连线、缩放控件、侧栏、菜单、来源弹层和读取日志跟随 DSH 实际颜色与字体。按钮采用胶囊样式，弹层与边框使用 DSH 风格。
- 明暗切换即时同步；独立 ThoughtDAG 的样式与偏好不再参与嵌入面板，消除了旧强制背景导致的棕色残留。
- 对话与思维图开关仍以会话页按钮定位，切换时位置和尺寸保持相同；窄屏保留主干和草稿入口。

上下文引用权限、固定截止位置、预算和主干归属规则不变。本次没有批量重排或迁移真实图，没有发送模型请求。

## 版本与提交

| 项目 | 版本 | 本地源码提交 |
|---|---|---|
| ThoughtDAG 插件 | 0.4.14-rc2.7 | 91e61d8 |
| Maintenance 插件 | 0.2.26-rc2.13 | b2accae |
| Maintenance Engine | 0.1.33-rc2.17 | b2accae |

只替换副本 19 个插件中的 ThoughtDAG 与 Maintenance，其他 17 个包沿用精确归档。主 profile 文件保持不变，主实例连接保持。提交留在本地，没有 push。

## 验证

- ThoughtDAG 28 项模型、客户端、宿主及主题测试通过，相关 ESLint 与构建通过。
- Maintenance 5 个相关文件共 27 项测试通过，全工作区类型检查与构建通过。补齐两处此前遗留的 schema 2/旧图摘要断言，并增加不能绕过图领域入口的契约测试。
- 合成浏览器检查浅深主题、竖向卡片、来源弹层、390px 窄屏菜单、开关位置，无页面错误。两张会话卡片横坐标相同、纵向相差 260px；窄屏菜单未溢出。
- 全 19 插件严格安装及六组隔离宿主 write/cold-read 检查通过，22 项插件间依赖关系通过。
- 新副本运行 `run-4d9055d7-5184-402e-ba3f-033205442d9f`；annotation-upstream、obsidian-links、stickers、thoughtdag 四面板 ready，图协议 2。
- 新 Engine 切换前后 534 个会话当前版本指针一致，数据库 schema 23 不变，完整性检查通过，Annotation 数据摘要不变。
- 实际安装的 85 个运行文件核验通过；另对 ThoughtDAG 的 8 个代码/页面文件进行核验，4 个实际 HTTP 提供的 SPA 文件逐字节匹配本次包。真实会话页面已正常完成插件加载。

验收未发起真实模型回答。真实用户旧图保留原位置，新默认布局适用于新卡片；已有图可主动使用“按来源排列”。

## 证据

目录：`D:/AI/DeepSeekHarness-Plugin/artifacts/graph-theme-vertical-20260915`

关键文件：`browser-verification.json`、`light-graph.png`、`dark-source.png`、`mobile-menu.png`、`candidate-packages.json`、`copy-installation-final.json`、`host-probe/result-final.json`、`engine-handoff-final.json`、`copy-binding-final.json`、`validation.json`、`graph-assets.json` 和 `logs/`。

所有回执均来自本次实际执行。旧插件和引擎保留在独立备份/发布目录。Engine 成对归档来自干净代码提交 b2accae；本报告作为部署后文档单独提交，不改变该包的代码来源。
