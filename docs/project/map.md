# Session Maintenance 项目地图

项目 ID：`0d05f813-7097-47d9-9e88-3d523bb537d6`。本地图依据 2026-09-23 的工作树源码重建，保持原项目身份与文档层级。它区分**已确认要求**、**源码可见实现**和**真实实例验收**：图中的连线和历史测试不证明当前安装实例已完成双向同步。用户已要求 Maintenance 本体与实例、Launcher 和具体插件解耦；这个目标目前还有明确的装配缺口。

## 项目目标与阅读入口

Maintenance 保存逻辑会话、工作区归属、不可变版本、来源/派生关系、同步回执和插件原值。Codex 日志仍由 Codex 拥有，DSH 原生会话由宿主拥有。平台适配器负责格式、身份和物理读写；插件适配器负责其数据的握手、映射和正常读取验证。核心不建立“通用图模型”，未知结构化数据按来源忠实保存并默认折叠。

| 想了解 | 入口 |
| --- | --- |
| 真源、工作区选择和同步权威 | [[TERM-canonical-source]]、[[TERM-maintained-workspace]]、[[DEC-sync-authority]] |
| 实例加入、启动对齐和运行期回传 | [[REQ-sync-coverage]]、[[REQ-detached-instance-attach-sync]]、[[IF-endpoint-sync]] |
| 宿主安全写回与退出恢复 | [[IF-host-writeback]]、[[IF-runtime]]、[[REQ-startup-recovery]] |
| 插件原值与 Lynn / GPT compat | [[REQ-opaque-mapping]]、[[IF-plugin-data]]、[[OBJ-plugin-graph]] |
| Codex 读取、镜像、续接和学习交接 | [[MOD-codex]]、[[MOD-continuation]]、[[REQ-learning-roundtrip]] |
| 看板、同步页和 Vault 绑定 | [[MOD-ui]]、[[REQ-sync-extension-navigation]]、[[REQ-offline-vault-binding]] |
| 当前架构差距与验收边界 | [[ISS-remaining-coupling]]、[[VER-map-rebuild]] |

三种阅读图使用同一地图记录：[整体责任与适配边界](diagrams/architecture.json)展示归属；[主要使用与恢复流程](diagrams/workflow.json)展示分支和失败路径；[GitNexus 模块源码图](diagrams/gitnexus.json)展示选定生产源码的文件、符号、导入和调用静态分析。HTML 页的“模块架构”可展开文件、函数和调用链；静态图不推断动态注册、RPC 或实际运行结果。

## 核心对象和已确认决定

[[OBJ-session]] 区分逻辑 ID、平台原生 ID、工作区成员与端点身份；[[OBJ-version]] 区分真源版本和物理投放回执；[[OBJ-runtime]] 保存运行租约、检查点与恢复证据；[[OBJ-extension]] 保存插件 namespace、类型、记录身份和原值。Lynn 图与固定引用作为插件专属内容见 [[OBJ-plugin-graph]]，不进入 Maintenance 核心业务模型。

[[DEC-authority]] 确认“真源事实在 Maintenance，宿主与插件语义在适配器”；[[DEC-sync-authority]] 确认以 DSH Home 根目录和稳定身份接入，未显式选择的同步范围为空。工作区在实例中存在、被“加入维护”和被选为双向同步对象是三种不同事实。已选范围在接管前以真源对齐，端点进入 active 后才接收实例已有会话增量；范围外工作区正常留在实例且不被覆盖。旧“实例新建工作区自动进入真源”要求已被用户撤销。

## 当前模块与接口

| 责任 | 当前代码与说明 |
| --- | --- |
| 规范核心及存储 | [[MOD-core]] 管逻辑会话、版本、归档/删除、派生和不透明原值；`packages/session-store`、`packages/transaction-engine` 保存并恢复事实。[[MOD-retention]] 管保留与清理预览。 |
| 端点协调 | [[MOD-endpoint]] 管选择、对齐状态、epoch、范围修订及运行期提交，消费 [[IF-endpoint-sync]]、[[IF-host-writeback]]。保存范围先返回，物理对齐单独报告。 |
| DSH 宿主接入 | [[MOD-dsh-host]] 在适配层发现、核验并接入实例，宿主插件提供写入屏障、归档刷新和回执；具体 DSH 格式编解码留在 DSH 适配包。 |
| 插件数据与页面 | [[MOD-plugin-adapters]] 中 Lynn 综合当前 Core/DAG/Sticker 组合，GPT compat 独立；[[IF-plugin-data]] 要求目标插件握手、投放后按正常路径读回。[[MOD-business-pages]] 按实际注册展示栏目。 |
| Codex 与交接 | [[MOD-codex]] 只读观察原日志和项目；[[MOD-continuation]] 在固定版本上建续接作业；[[MOD-learning]] 对已确认学习会话执行受控双端交接。 |
| 运行、阅读与界面 | [[MOD-runtime]] 负责准备/关闭/恢复，[[MOD-context]] 负责原生上下文证据，[[MOD-reader]] 提供有界阅读；[[MOD-ui]] 呈现状态、同步与扩展页，[[MOD-vault]] 管独立 Vault 绑定。 |

这些模块的公共 DTO 由 contracts 保存。仓库 [[CONTRIBUTOR-rules]] 要求平台格式进入 adapter、编排留在 Engine、变更后核对测试和来源。当前 Engine `composition-root.ts` 仍直接导入 DSH/Launcher/Lynn/GPT 具体实现，见 [[ISS-remaining-coupling]]；因此“核心包和端点协调较为抽象”不能扩大成“整个 Maintenance 已完全解耦”。

## 主要使用流程及验收边界

1. **加入与对齐**：DSH 侧显式加入维护 → Maintenance 编辑并保存同步选择 → Engine 核对稳定实例身份、策略和版本 → 宿主适配器取得独占写入、排空既有写入并投放 → 核对宿主回执后端点 active。失败进入 blocked，保留原数据；新会话的插入式发现可与已有会话的反向写回分别处理。见 [[REQ-maintenance-source-list]]、[[IF-host-writeback]]。
2. **运行期双向变化**：已选范围内的新增、续写、改名、移动、归档、取消归档和删除带 epoch 上报；Engine 串行创建规范版本并按端点投放，目标回执决定是否成功。来源标题不能退化为生成 ID，未选范围不能串入真源。见 [[REQ-sync-coverage]]。
3. **插件数据恢复**：真源保留原始 namespace、dataType、recordId 和 value；Lynn/GPT 等各自适配器先握手，再投放到插件平常读取的位置并核验。目标缺插件时保留且不误投放，未知结构默认折叠。见 [[REQ-opaque-mapping]]、[[IF-plugin-data]]。
4. **Codex 与学习交接**：Codex 只读导入规范版本；普通续接固定来源版本并保存作业回执。实验性学习交接要求显式双端绑定、成功同步回执、边界后完整新增问答和提交前冲突复核；未通过真实往返验收不得声称闭环。见 [[REQ-learning-roundtrip]]。
5. **运行与恢复**：准备租约和原生空间 → 宿主运行/追加 → 正常 flush、drain、close → 检查点或旧运行恢复。身份不明、旧写入未释放或回执不确定时阻断，不能靠健康接口或直接杀进程宣布成功。见 [[MOD-runtime]]、[[IF-runtime]]。

## 当前来源、限制和迁移

源码包清单声明 Engine `0.1.43-rc2.95`、Dashboard `0.1.20`、DSH 接入插件 `0.2.27-rc2.79`；它们不是在线实例的实测版本。Codex 工作区原生写回在当前策略中仍显式不支持，不等同于 DSH 工作区双向会话维护。当前说明见 [[IMP-current-source]]，地图自身的检查与真实产品验收范围见 [[VER-map-rebuild]]。

重构前已保存 [重构前覆盖清单和 103 条旧资产逐条去向](migration/README.md)（原始 JSON 同目录保存）说明保留、合并、历史归档和用户撤销项。旧地图的 16 条可展开开发历程、1 条日志和来源定位索引现已补回“开发日志”；另外 6 份尚未绑定来源的草稿由 [[JRN-20260923-history-restoration]] 列出。其他旧地图内容可按 `d3fdbe3:docs/project/` 查回，[旧 ID 索引](legacy-id-index.md)只用于定位；原规格、变更和报告仍在 `docs/superpowers`、`docs/changes`、`docs/reports`。旧时点成功不自动更新为今日验收。
