# Adapter自注册子页与整页导航修复


## 2026-09-18 再次验收后的明确修订

每个Adapter固定维护“扩展数据”页；其他子页必须由该Adapter或其业务提供方实际注册，Maintenance不得因公共信息页API存在就给所有Adapter生成“插件信息与接入”。本次现有注册中仅Obsidian拥有该信息页，GPT兼容插件和ThoughtDAG只显示数据页；未来自定义提供方注册的页面按自身标题及namespace/provider身份生成子栏目，多实例归入同一栏目。

扩展的Adapter选择位于内容顶部一级导航，Adapter内部子目录紧随其后；同步的Maintenance/Codex位于内容顶部同级导航。均使用平直文字与选中底线，不使用气泡/圆角分段按钮。正文位于导航之外，占用整块内容区域，切换的是整页正文；不得把完整子页嵌在大卡片方框内切换。已有选择、未保存草稿和未完成操作回执跨子栏目切换保留。


## Dashboard .1.6 导航纠错（2026-09-18）

用户再次验收指出：Obsidian专属信息页被前端错误套用到GPT与ThoughtDAG，顶部选择仍为气泡样式，整页内容被大卡片包裹。原因是ExtensionCategoryView以全局listBusinessPages能力存在作为显示通用信息入口的条件，而不是检查当前Adapter注册。现已改为固定数据页加实际namespace/provider注册页；移除两个未注册的空信息入口，自定义页面使用注册标题；顶部平直一级/二级导航，正文整页切换，保留草稿与幂等回执。此修订替代此前“所有插件都有数据与信息两页”的错误概括。

11项针对性测试、Dashboard类型检查及构建通过。当前Engine .40静态部署Dashboard .1.6，17个文件逐项哈希一致，旧静态资源备份并保留；未重启Engine或DSH，同一boot 5c70b708-f8f4-43e7-842d-9419ab58d142 / run-cf18aaf6-8b8f-4ef7-aba6-37fbca6859ca持续running，Engine PID51548。工作区范围、接入登记和Launcher hook内容未变。真实浏览器分别打开GPT、ThoughtDAG、Obsidian信息页以及Maintenance/Codex同步页，确认入口归属、两层底线导航和无外层卡片的正文切换；没有执行绑定、解除或保存名单。

证据与备份：D:/AI/DeepSeekHarness-Plugin/artifacts/dashboard-0.1.6-navigation-20260918/installed.json及dashboard-before。两次部署脚本校验故障也保留说明：第一次Windows basename处理错误发生在覆盖前；第二次覆盖后误用inspect返回结构导致回执写入失败，随后按live.bootId/run.id完成独立哈希和持续运行核验。未用脚本成功代替视觉验收。用户本次要求不用子代理，收到后立即停止已派出的代理，后续代码、测试、安装与浏览器检查均由主任务完成。
