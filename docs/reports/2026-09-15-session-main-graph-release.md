# 会话主干图：联合实施与副本交付

交付日期：2026-09-15。目标：Launcher 中的 **0.1.5-rc.2 副本 / web**。

本次按 2026-09-14 确认的规格完成修改，提交到本地 Git，并已安装、重启副本。主实例 profile 保持原样，没有发起真实模型回答，也没有批量迁移或删除旧图、会话、笔记。

## 已交付功能

- 每会话一张接收方主干：X 引用到 Y、从 X 创建贴纸会话 Y，均为 X → Y，主干归 Y；不自动生成全部会话总图。
- 空白、节点、边的右键菜单；键盘和“更多操作”访问同一操作。空卡片不创建会话，开始时先选工作区；创建意图持久保存，异常重试沿用相同工作区与会话身份。
- 节点进入真实 DSH 会话，准备已有固定入向引用，保留草稿和附件，等待用户发送。引用保留原版本与完整回复截止位置；后续通过有预算的只读工具按需读取。
- 右键“查看来源”替代常驻“局部问答”，按固定版本预览、选文和引用；预览不冒充模型已读。
- 删除卡片/边统一撤销对应权威引用；旧布局不能恢复该权限。保留真实会话、历史回答及其它独立引用。并发失败明确保留待恢复状态。
- 来源选文高亮与蓝色跳转符号；多目标可选择，重新打开按权威关系恢复。普通红色贴纸保持既有行为。
- 图内查看固定来源、准备/交付状态、稳定事件片段与继续位置。默认每主干日志最多 256 条 / 262144 字节，每页 20 条；布局与日志独立更新，仅保存当前有界对象，没有每次读取的整图快照。
- 搜索只记录命中片段；当前页已交付区间可以合并重叠或连续部分，不跨空白。停用期间未记录或已裁剪的回执明确返回未记录，不阻塞独立合法引用，不伪造历史。
- Maintenance schema 2、宿主协议 2、扩展 Adapter 和兼容清单同步更新。全局维护网络、全局影响与批量准备重答的专用 UI/API 已移除，共享对象服务与各域维护面板保留。
- 旧图显式核对归属，歧义图保留待处理；不把旧知识线自动升级为读取权限。独立材料卡等尚未确认删除的能力保留。

## 精确版本与本地提交

| 项目 | 安装版本 | 本地提交 |
|---|---|---|
| Maintenance Engine / 插件 | 0.1.33-rc2.16 / 0.2.26-rc2.12 | `8b37aa4`，包含 `127538f`、`505a6d1`、`c2d1393` |
| ThoughtDAG | 0.4.14-rc2.6 | `40392e6` |
| Annotation Core | 0.3.12-rc2.8 | `3b92984` |
| Sticker Board | 0.7.3-rc2.14 | `c611166`，功能提交 `81e6deb` |
| Sidechat | 0.4.7-rc2.8 | `63634bc`，兼容补版 |
| Bridge Lifecycle | 0.3.3-rc2.12 | `e0e9295`，兼容补版 |
| Reference Adapter | 0.3.4-rc2.12 | `272e3f2`，兼容补版 |
| Reference Suite | 0.3.4-rc2.14 | `33ddb9c` |

Obsidian Companion 保持 0.6.4-rc2.6。全部 19 个 profile 插件保留；这次替换 8 个，Suite 父子挂载结构没有改变。提交均在本地，没有推送远端。

## 验证结果

相关自动测试合计 620 项通过：Maintenance 104、ThoughtDAG 23、Annotation 187、Sticker 129、Sidechat 101、Lifecycle 34、Reference Adapter 30、Suite 12。相关类型检查与构建通过；ThoughtDAG 相关源码检查无错误、无警告。

ThoughtDAG 的 7 组合成浏览器流程通过，覆盖空卡片/取消、工作区分页与创建、接收方归属、固定来源、草稿保留、日志、键盘撤销、冲突恢复及窄屏菜单；无页面错误、无模型调用。截图和执行结果见其仓库 `.local-e2e/main-graph-browser/`。

副本交付检查已完成：

1. 19 个包通过严格 peer 安装与身份核对，22 处插件间版本约束匹配。
2. 新配对引擎归档中的维护插件与安装归档一致；完整宿主的 write/cold-read 两阶段 core、handles、upstreamCatalogue 六项通过，探针仅使用隔离合成 Home。
3. 正常停止副本后再切换引擎，533 个会话当前版本指针不变，数据库完整性通过；旧引擎目录保留。
4. 重新生成与实际安装闭包一致的运行校验信息并连接成功，主实例仍连接，主 profile 未变，Launcher 绑定要求未放宽。
5. 副本重新运行：`run-e21a9405-2528-40e6-af32-b3b647c9da21`，当次地址 `http://127.0.0.1:37225`。85 个已安装运行文件摘要匹配；图协议 2 的存储、会话、主干、引用能力可用。
6. annotation-upstream、obsidian-links、stickers、thoughtdag 四个面板均 ready；全局 network 接口返回 404；画布目录不混入披露日志对象。原有 Annotation 数据摘要保持不变，实际 DSH 会话页面正常加载。

真实模型回答、用户的跨窗口操作习惯、大规模旧图迁移和人工长时间并发操作未作为已通过验收；本次没有用真实会话制造新的测试图或自动发送消息。逐项 AC23–40 的覆盖与剩余人工场景见[验收映射](D:/AI/DeepSeekHarness-Plugin/artifacts/session-main-graph-20260914/acceptance-map.md)。

## 证据与使用

发布证据目录：[session-main-graph-20260914](D:/AI/DeepSeekHarness-Plugin/artifacts/session-main-graph-20260914)。关键文件包括 `candidate-packages.json`、`maintenance-tests-final.log`、`host-probe/result-final.json`、`engine-handoff-final.json`、`copy-binding-final.json` 和 `validation.json`。目录沿用 9 月 14 日任务起始日期，交付于次日。

进入副本的会话“思维图”后，可在空白处右键添加卡片；节点右键进入真实会话或查看来源；边右键查看固定来源与读取位置，或移除该关系。已有旧引用可显式选择“导入当前目标已有引用”，不新增权限，已解除关系不会恢复。操作说明见 [ThoughtDAG MANAGED.md](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/dsh/MANAGED.md)。
