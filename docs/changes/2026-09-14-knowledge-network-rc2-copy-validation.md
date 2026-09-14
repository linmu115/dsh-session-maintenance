# 会话贴纸、知识链接与全局维护网络：副本安装验证

已安装到 **0.1.5-rc.2 副本 / web**，由启动器正常停止和重新启动，实际页面验证时间为 2026-09-14T08:39:50.881Z。运行入口为 http://127.0.0.1:53560；认证仍由启动器提供。

## 用户入口和功能

- 会话页顶栏的“对话｜思维图”切换到画布后仍显示完整双向开关，并高亮“思维图”。返回再进入复用现有画布和面板状态。
- 会话页顶栏“会话贴纸”，以及画布左侧“会话贴纸 · 新建 / 管理”，可以创建真实独立会话贴纸、挂接已有会话、从选区建立引用并进入完整会话页；对象支持删除及恢复。
- 笔记关联使用独立的 Obsidian 笔记身份和知识链接记录，支持双向跳转。笔记正文留在 Vault；只有主动关联的笔记才添加身份属性。迁移入口按会话冻结旧贴纸、展示冲突、导入并核对回执，成功后由 Maintenance 管理。
- 画布左侧“全局维护网络”提供当前实例的跨画布会话、贴纸和笔记关系目录及搜索，可查看来源更新影响。选择目标后准备新的来源引用和重审说明，保留原有草稿，由用户检查并发送；不自动重新回答。

## 安装版本

Maintenance Engine：0.1.33-rc2.11。

| 插件 | 版本 |
| --- | --- |
| dsh-annotation-core | 0.3.12-rc2.6 |
| dsh-obsidian-bridge-lifecycle | 0.3.3-rc2.10 |
| dsh-obsidian-bridge-protocol | 0.3.3-rc2.1 |
| dsh-obsidian-reference-adapter | 0.3.4-rc2.10 |
| dsh-obsidian-session-reference-suite | 0.3.4-rc2.10 |
| dsh-session-maintenance | 0.2.26-rc2.9 |
| dsh-session-sticker-board | 0.7.3-rc2.10 |
| dsh-thoughtdag | 0.4.14-rc2.3 |

安装共 19 个插件。原 0.1.5-rc.2 主实例的配置、依赖和连接保持不变。Engine 切换时核对 530 个会话版本记录未变化。

## 验证与实际修复

- 生产构建通过；ThoughtDAG 20 项宿主测试及 7 项浏览器场景通过，贴纸 102 项回归和 6 项浏览器场景通过。Maintenance 最新扩展/知识/运行证明 11 项测试通过，此前本阶段 65 项相关回归通过。
- 19 个真实 RC2 宿主插件的写入和冷启动读取夹具验证通过；检查原生共享对象身份和上游工具目录。测试仅使用标记的合成目录，没有调用模型。
- 运行副本中，注释、贴纸、Obsidian 链接、ThoughtDAG 四个扩展状态均为 ready。实际知识目录、对象列表、全局网络和影响接口返回成功。
- 实际浏览器直接加载已安装文件，无脚本替换，验证两端切换状态、画布返回后保留状态、全局维护网络、会话贴纸弹窗，页面异常为 0。实际 Companion 0.6.4-rc2.4 的认证及知识接口可用。
- 修复了 RC2 宿主前缀路由尾斜线导致的 405、浏览器默认定时器接收者导致的 Illegal invocation、可选生命周期服务直接取属性导致的 Cordis 初始化失败，并更新版本兼容表。

## 数据与验收范围

未自动迁移整个 Vault，也未关联或改写用户笔记、发送对话或调用模型。旧数据保持原位，待用户从指定会话入口选择迁移；存在冲突时由用户决定。原生完整会话、既有固定引用截止位置和版本语义保持独立。界面及合成数据验证不替代用户实际迁移验收。

## 本地提交与证据

- dsh-annotation-core: 49191157795ce74952e5bd8874472c1e606bc90f
- dsh-sidechat: 3e8873e32e3ad77f68495dd0577340bb75e354df
- dsh-obsidian-bridge-lifecycle: 7dc5c45223968c9758bed13a8f1f0677d8f2da89
- dsh-obsidian-reference-adapter: 5195a563c2dd564da47ab48825e7a0f8cda80c3e
- dsh-session-sticker-board: 1baef32ee8778d12d09cd74409db9617e30ed9ba
- obsidian-deepharness-bridge: 8c898561556e805b0fd1ab5526fa2a9b6c4ddf28
- dsh-obsidian-session-reference-suite: 34f56ae415a28d8c140477dbbd8a60b75470d3af
- dsh-session-maintenance: 461fa617034a04b61b4ba8efef889791b4da3d6e
- thoughtdag: 4b4bcb48028e8c12656061bd875e14e1479dbf25

- 本阶段设计：[会话贴纸与维护网络规格](../superpowers/specs/2026-09-14-session-stickers-knowledge-network.md)
- 安装及校验：D:/AI/DeepSeekHarness-Plugin/artifacts/knowledge-network-rc2-20260914/client-fix
- 实际界面：live-knowledge-network.png、live-session-stickers.png、canvas-view-switch.png。
- live-validation.json 记录运行及界面结果；host-probe/result-final.json 记录精确宿主验证；copy-binding-final.json 记录连接。安装包的源码提交以 engine-package/phase2-manifest.json 为准，此验收文档另作一次本地提交。
