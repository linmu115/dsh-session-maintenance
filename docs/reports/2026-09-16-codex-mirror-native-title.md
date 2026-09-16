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
