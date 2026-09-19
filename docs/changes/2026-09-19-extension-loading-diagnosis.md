# 扩展栏目缓慢与缺项：运行包核查 · 2026-09-19

本轮用户反馈：扩展栏目每次打开读取很久，GPT 与 ThoughtDAG 一级栏目不见，仅剩 Obsidian 桥。

## 已核验事实

当前运行连接从本机 connection.json 读取，令牌仅在请求内存使用。已安装 startup-recovery .41 发行包的扩展 GET 路由仍无条件 await native-extension-index 写入任务，刷新 GPT 索引后才返回导航。该索引会查询已投影会话，并对版本变化的会话读取规范事件、生成派生摘要；本地数据不意味着没有扫描、解码和队列等待。

首次 /v1/extensions/business-panels 实测 24946 ms；后续同接口 789 ms。/v1/health 76 ms，/v1/business-pages 93 ms。后续业务名单返回 gpt-compat / obsidian-series / thoughtdag 三组，均 ready，顶层对象数分别 5 / 30 / 12。慢请求中队列等待与事件扫描各占多少未单独测量，不能把总时长全部归为磁盘耗时。

安装版 Dashboard 只在进入页面时读取业务名单，没有工作树新版的10秒超时和5秒重试。Obsidian Bridge 的信息页来自独立快速接口，可独立建立一个栏目。由此支持“业务名单加载慢或失败而只显示信息页栏目”的解释，不能声称已实测用户页面的具体失败状态。未完成真实浏览器 UI 验收；没有证据表明适配器或数据被删除。

## 已有修复与部署边界

工作树 d273281 已使导航/非GPT读取绕过GPT索引，并增加栏目重试与扩展注册恢复。当前安装包未包含该修复。复跑 extension-navigation-latency、extension-navigation、extension-page：8项通过。

正式只读停机预检显示仍有1个托管运行，拒绝引擎停止。未发送信号、未改绑定和真实名单、未安装或激活。本次仅诊断和记录，不能标记为运行版性能已修复。需在Launcher正常停止托管实例、回执满足后，整合已有启动恢复与扩展修复，按已记录配套Engine/插件发行流程激活并实测；仅更新Dashboard不足以消除后端阻塞。
