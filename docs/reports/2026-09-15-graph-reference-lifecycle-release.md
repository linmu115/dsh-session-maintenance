# 蓝色引用删除、会话归档与节点开始恢复

2026-09-15 已完成实现、本地提交、安装及 0.1.5-rc.2 副本重启。需求对应 AC41–AC45，见 [设计与功能需求](../superpowers/specs/2026-09-10-session-context-graph-requirements.md)。

## 功能结果

- 来源选文的蓝色引用号提供右键删除。同一选文的多条引用可分别选择；服务端先核对来源会话及 referenceId，再在同一事务中撤销引用和更新图。成功后刷新标记与目标主干，保留普通红色贴纸和真实会话。已解除但本地气泡尚未同步时显示明确提示。
- DSH 原生归档通过官方 workspace domain 的持久化事件接入 Maintenance；Maintenance 自身归档和 Canonical 提交也接入同一生命周期。归档会撤销以该会话为来源或目标的活动引用，清除相连的待绑定边，归档自身主干；插件停用、画布关闭及退出尾部写入不会绕过规则。
- 恢复会话只恢复因所属会话归档的主干；已撤销引用和待绑定边不复活，手动删除的图保持删除。Maintenance 扩展目录区分归档状态，已打开画布转为只读并保留未保存布局。
- 修复已有会话卡片开始时报“引用已发送，但当前实例缺少对应提交记录”。Core 从目标范围内的 Maintenance 记录恢复轻量读取授权，保留原来源版本、截止位置与目标身份。恢复记录与发送回执、提交日志分开，不重复发送、不改绑原消息、不复制全文。
- 原有披露预算及交付回执继续有效。单条工具读取仅核对该引用，列表核对当前页，避免为一次读取遍历全部历史引用。读取期间被撤销时拒绝交付；离线或身份未知不能被解释成删除。

## 源码与发布版本

| 项目 | 版本 | 本地提交 |
|---|---|---|
| Annotation Core | 0.3.12-rc2.9 | 49ad43e |
| 会话贴纸 | 0.7.3-rc2.15 | 3303858 |
| ThoughtDAG | 0.4.14-rc2.8 | dc4da1e |
| Maintenance 插件 / Engine | 0.2.26-rc2.14 / 0.1.33-rc2.18 | a249b46 |
| Sidechat | 0.4.7-rc2.9 | be30c3b |
| Obsidian Lifecycle | 0.3.3-rc2.13 | de4795d |
| Obsidian Reference Adapter | 0.3.4-rc2.13 | 81dcb8b |
| Reference Suite | 0.3.4-rc2.15 | f649807 |

安装保留原 19 插件组合和 Suite 父子加载拓扑，只替换 8 个相关包。所有提交仅在本地。Engine 包固定到干净源码 `a249b460a220de7acdadc95e11c696e1607e91e8`；本报告为后续文档提交，不改变已发布代码。

## 验证

- Core 全量 192 项测试通过；最后增加两项并发测试、收窄状态核查范围后，35 项相关测试及类型检查通过。
- Sticker 全量 140 项测试、类型检查、构建通过。ThoughtDAG 35 项测试、修改文件 lint、类型检查及打包构建通过。
- Maintenance 归档/状态/图相关 35 项测试通过；增加待绑定边规则后图领域及真实 RC2 隔离 HTTP 的 18 项测试通过。原生归档桥 8 项测试及兼容版本断言复测通过。
- Store、Projection Lifecycle 和扩展看板回归共 142 项。首轮 137 项通过，5 项因两份旧迁移夹具没有移除 schema 23 新表失败；补齐合成夹具后，两文件 11 项全部通过。没有修改运行迁移逻辑来迁就测试。
- Sidechat 101、Lifecycle 34、Reference Adapter 30、Suite 12 项测试通过。Maintenance 完整类型检查和构建通过。
- 隔离浏览器验证：外部撤销立即移除边且保留未保存空卡片；归档目标后禁用保存、编辑和开始，显示归档状态及另存布局入口。验证没有使用真实会话数据。
- 新安装的完整 19 插件进行了 write/cold-read 两阶段的 core、handles、upstreamCatalogue 六项宿主检查，全部通过；未复用旧通过回执。

ThoughtDAG 构建时一次 pnpm 自动安装与仓库 npm 锁不匹配，已用原 package-lock 恢复依赖并重新构建；新增 pnpm 文件未进入仓库。Suite 与成员构建并行的临时读取失败已在成员完成后顺序复测。诊断保存在发布证据目录。

## 实际副本

- 实例：`i-7ecb6c19-80a5-4c2e-97e6-484bbfc0e926`，profile `web`。
- 启动状态：`running`，run `run-cfa164d9-22d9-4172-801a-fa4d82101b81`。
- 本次页面地址：`http://127.0.0.1:57758`；下次启动端口可能变化。
- Engine：0.1.33-rc2.18，PID 84248，本次地址 `http://127.0.0.1:54117`。
- 正常停止后完成部署备份及安装；Engine 交接前后的 534 个权威会话 head 一致，schema 保持 23。
- 19 插件的 89 个运行文件与安装包相符；ThoughtDAG 实际提供的四份 SPA 文件及版本接口与 0.4.14-rc2.8 相符。
- annotation-upstream、obsidian-links、stickers、thoughtdag 四面板均为 ready；图协议 2，存储、会话、主干及引用能力全部可用。
- 原主实例的配置及连接保留。启动验证时原 Annotation 数据文件摘要不变。
- 实际 WebUI 可打开已有会话，显示“会话贴纸”及“对话 / 思维图”入口。本轮没有发起真实模型回答，也没有为验证而删除或归档用户会话；真实业务删除/归档交互由用户验收。

发布证据根目录：`D:/AI/DeepSeekHarness-Plugin/artifacts/graph-reference-lifecycle-20260915`。关键证据为 `candidate-packages.json`、`host-probe/result-final.json`、`engine-handoff-final.json`、`copy-binding-final.json`、`validation.json`、`graph-assets.json`、`browser-archive-snapshot.txt`。
