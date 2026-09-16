# Codex 镜像冷读取标题修复

## 问题与要求

用户于 2026-09-16 报告：Codex 的“机试DeepLearning”映射到 DSH 后显示为工作目录“计算机四大”，要求修复、提交并推送。

只读核对发现 Codex 名称、Maintenance display_title 和当前运行 projection catalog 均正确；DSH RC2 副本的原生 title 缓存已经是 null。原镜像没有 session/title 事件。9 月 15 日的修复恢复了目录缓存，但没有给 Codex 镜像生成可从原生日志独立恢复的标题。

验收要求：标题不依赖预填缓存；冷读取和 Codex 改名后的重新物化保留名称；原始 Codex 行、消息锚点、既有 DSH 尾部序号和 DSH 重命名优先级保持正确。

## 实现

DSH 0.1.5 Adapter 在 portable 前缀末尾生成官方 session/title 事件；空 Codex 镜像同样处理。该事件只属于生成的 DSH 投影，不追加到 Codex 日志或 canonical 来源行。放在转换前缀末尾，避免移动既有消息锚点。原生 DSH 历史沿用日志中的标题。

首次续写后的 derived 历史利用首条原生尾部的序号保留标题槽位；升级前没有该槽位的派生历史不插入事件、不移动尾部。后续真实 DSH session/title 仍按日志顺序覆盖生成标题。生成标题属于投影元数据，重新物化时取该会话当前 canonical 名称。

Adapter 版本从 0.1.2 升至 0.1.3，以改变持久缓存指纹，让已存在且 head 未变的镜像在升级后的准备阶段重新物化。

## 验证与交付边界

新增合成回归覆盖官方 V3 编码、zstd 解码、Session 冷恢复、无缓存标题折叠、Codex 改名、source receipts 和锚点保留、空/非空镜像派生以及升级前原生尾部兼容。Adapter 全套、投影生命周期、Engine 标题持久化/目录同步与插件缓存测试合计 26 个文件、121 项通过。Adapter 类型检查和构建通过。

本次提交是源码修复，不替换运行包、不重启宿主、不修改真实 Codex/DSH Home。运行实例需安装包含 Adapter 0.1.3 的配套 Engine 构件，并经过正常启动准备，才能应用这次修复。

## 后续部署与重启验收

用户随后明确要求更新并重启，2026-09-16 已完成。目标为 Launcher 的 `0.1.5-rc.2 副本 / web`；以提交 `a7f998e8463cde606c8558d47f0f6604804da85a` 构建，保留当时工作区仅文档未提交的事实。Engine/插件外层版本仍为 `0.1.33-rc2.28 / 0.2.26-rc2.22`，内嵌 Adapter 为 `0.1.3`；用产物摘要区别同版本旧包。

- Engine 包 SHA-256：`21c4c9a0b2ddd07b04072974cb835b08e41d03d7537ab16648399d4909b8572d`。
- 插件包 SHA-256：`3c3c2ba35f4571390e7ff6f615f4acec0589bd987c208342a7ddf06e151db49d`。
- DSH 经鉴权退出入口排空，旧运行取得 recovered/final receipt，活动运行与待执行任务归零后才切换 Engine。保留停机数据库备份、旧包及插件目录。
- 官方插件安装完成，新包逐文件校验通过，其他 18 个插件逐文件校验未变。安装初次遇到参数不兼容，随后依赖重建停滞；仅终止安装进程，保留旧插件目录后按现有部署方式重装成功。
- 新 Engine 切换前后 canonical 正文、版本及 head 摘要一致，schema 保持 24，主 Profile 配置未变；通过 Launcher 原生启动入口重新启动副本。
- 真实镜像的 V3/zstd 文件严格解码通过，末尾有 `session/title`，标题为“机试DeepLearning”；官方 `session.list` 同时返回该名称。六个扩展命名空间均 ready，SQLite quick_check 为 ok。
- 未调用真实模型。实际验收覆盖正常重启、原生文件独立恢复及官方列表；未额外发送聊天消息或改写用户标题。

本地部署与回退证据在 `D:/AI/DeepSeekHarness-Plugin/artifacts/codex-mirror-title-deploy-20260916/`，以 `validation.json`、`shutdown.json`、`installed.json`、`engine.json`、`binding.json` 和包清单为准；这些本机文件不随源码提交。
