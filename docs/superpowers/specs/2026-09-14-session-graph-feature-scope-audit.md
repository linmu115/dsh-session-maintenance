# 会话图谱：现有功能取舍与适配核查

日期：2026-09-14。范围：本地 DSH 0.1.5-rc.2 的 ThoughtDAG 集成及其 Maintenance、Annotation、Sticker 依赖。状态：源码只读核查和需求更新；未修改插件实现或运行数据。

本文件回答“现有 DAG 里还有哪些能力不符合我的使用方式”。已由用户确认的删除/调整项与额外建议分开列出。产品要求以[设计和功能需求](2026-09-10-session-context-graph-requirements.md)为准，实施分工见[插件改动清单](2026-09-10-session-context-graph-plugin-changes.md)。

## 1. 核查范围与证据

| 仓库 | 本次核查提交 | 主要入口 |
|---|---|---|
| ThoughtDAG | `e2ce52b`，`codex/rc2-maintenance-graph` | `src/main.tsx`、`src/maintenance/ManagedGraphApp.tsx`、`model.ts`、`client.ts`、`KnowledgeNetwork.tsx`、`dsh/lib/managed-graph.js`、`dsh/lib/client.js` |
| Session Maintenance | `42441ec`，`codex/rc2-session-context-graph` | 图/上下文/知识服务，`apps/engine/src/extensions/adapters.ts`，共享 graph/context 合同，Dashboard 全局网络入口 |
| Sticker Board | `b1ff2ea` | `src/client/overlay.tsx`、`knowledge-panel.tsx`、`index.tsx`、`styles.css` |
| Annotation Core | `7433774` | `src/host/upstream-tools.ts`、`upstream.ts`、`system-prompt.ts`、引用创建/提交/撤销路径 |

ThoughtDAG 本地路径为 `D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag`；后三者位于 `D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/`。下列行为依据当前代码，不能把文档中的目标状态当成当前已经实现。

DSH 构建在 `src/main.tsx` 的 `VITE_DSH_BRIDGE` 分支直接加载 `ManagedGraphApp`，独立应用走另一分支。不能把上游独立应用有某功能，等同于 DSH 当前正在运行该功能。

## 2. 已确认删除或调整

| 当前功能/行为 | 核查结果 | 本次确定的处理 |
|---|---|---|
| 全局维护网络 | `ManagedGraphApp.tsx` 挂载 `KnowledgeNetwork.tsx`，聚合当前实例会话、画布、贴纸、笔记和引用 | 删除 DSH 入口、组件挂载及专用查询/状态 |
| 全局影响查看与准备重答 | `KnowledgeNetwork.tsx` 检查来源变化，`dsh/lib/client.js` 将重答说明/引用送入目标草稿，仍需用户发送 | 整项删除，不保留为未来待实现功能，不自动转移到别的菜单 |
| Maintenance 全局网络面板 | `apps/dashboard/src/app.tsx` 的扩展页加载 `knowledge-network.tsx` | 一并删除全局网络/影响入口；保留下面各扩展数据管理面板 |
| “局部问答”常驻区域 | 是所选会话/材料的已有问答预览，没有另一个模型执行器；同时承载选文/引用/会话贴纸入口 | 删除名称和常驻区域；右键“查看来源”按需预览，选文入口迁移过去，提问统一进入真实会话 |
| 拖线仅创建知识关联 | `onConnect` 调 `connectKnowledge`，当前拖线没有上下文读取作用 | 改为经过确认和固定范围解析的有向上下文关系；取消普通装饰知识线作为新建选项 |
| 仅移除卡片/线条呈现 | `removePresentation`、右侧按钮和 Delete/Backspace 只更新节点/边数组；实际撤销另走接口 | 所有删除入口统一撤销选定连接，后续读取被阻止，刷新不复活；保留真实会话和既有回答 |
| 无主干归属的自由画布列表 | 当前 graph schema 只有节点/边/视口，侧栏允许新建和选择多份画布 | 新增目标逻辑会话归属、按需唯一主干；旧混合画布留待归属/拆分，不扫描全历史自动建图 |
| 手动“载入已有引用”作为主要同步入口 | 当前通过 `maintenanceGraph.relations` 获取元数据，再导入已有节点间已发送关系 | 自动建图/同步以目标引用动作触发；普通刷新只取当前主干范围。手动修复入口可留在更多菜单，不全局导入 |
| 添加节点和选区贴纸入口分散 | 主要位于顶部操作栏及节点详情；尚无完整空卡片右键流程 | 对象操作集中到右键。空卡片延迟绑定，会话创建先选工作区；保留键盘/触屏等效入口 |

主干例子：X 的选文创建会话贴纸 Y，图属于 Y，X → Y；X 的来源选文出现高亮和蓝色引用符号，点击进入 Y。X 被其它会话引用，不触发 X 自己的图自动展开这些下游。

## 3. 必须保留或随之适配

| 能力 | 保留原因与边界 |
|---|---|
| 原生会话导航、工作区/会话目录 | 用户需要从右键添加已有会话和进入节点；按页读取目录，不是全局图功能 |
| Annotation 固定上游读取/搜索与预算 | 正是按需披露的执行能力；初始来源问答和后续工具统一纳入限额，不能因移除预览区而删除 |
| 引用身份、源版本、截止位置和撤销记录 | 图的有向边依赖这些权威记录；取消总图不取消关系数据 |
| `maintenanceKnowledge` 中贴纸/笔记对象服务 | `dsh/lib/managed-graph.js` 的关联已有贴纸仍使用该服务；只删除网络/影响专用能力，不能整个服务删掉 |
| ThoughtDAG/Sticker/Obsidian 各 Adapter 数据维护面板 | 用户仍要在 Maintenance 看结构、对象、删除和冲突；按域面板与全部会话总图是不同功能 |
| 来源预览、稳定锚点与分页 | 右键查看来源需要这些能力；无读取权限的 UI 预览不记成 AI 已读取 |
| 来源选文高亮 | 会话贴纸需扩展为蓝色符号导航，普通贴纸红色符号保留；同一位置多引用按关系计数维护 |
| 保存、修订冲突提示、重试和恢复 | 用于避免覆盖图与关系；AI 的位置日志另行有界更新，不能让每次读取触发整图冲突 |
| 拖动、缩放、适合画布和按方向排版 | 直接服务日常图操作，保留在右键或轻量工具区；这些布局动作不改变上下文授权 |

## 4. 额外精简建议，尚未作为确认删除项

| 能力 | 建议 | 理由与保留范围 |
|---|---|---|
| 独立“制作材料卡” | 从常用操作中移出，优先使用来源预览、跨会话引用和会话贴纸；是否完全取消等用户决定 | 它只呈现选段，不是执行会话，容易与新会话卡片混淆；保留旧对象和稳定来源读取，不能升级时删掉已有材料 |
| 通用“关联已有对象”浏览器 | 收到右键的按类型添加/查看来源中，避免常驻一个跨域对象列表 | 会话图的核心是上下文；笔记双向关联仍在原关联功能中，不把所有链接画成上下文边 |
| 独立画布的手动保存按钮、修订号常驻展示 | 可在自动保存可靠后精简；本轮不把自动保存当作额外前置功能 | 先保证关系撤销和日志更新可恢复，不能为简化 UI 去掉冲突处理或制造丢失编辑 |

这些建议与已确认删除项不同：当前只记录取舍理由，未来实施不可直接将其视为用户已同意删除全部能力。

## 5. 未加载的上游能力不批量清理

上游独立应用中的 SessionAtlas/Agent 对话地图、全文镜像、独立模型代理、节点内生成及自动备份路径不属于当前 DSH 的 `ManagedGraphApp` 主入口。`dsh/MANAGED.md` 也记载旧 `/disksessions`、`/inject`、`/stream` 等桥接路由已停用。

本次保持这些能力不进入 DSH 产品流程，不为删全局网络修改整个上游独立应用或另建模型运行层。若以后要删除独立版源码、减包或停止维护整个独立应用，应单独确认范围并核对构建依赖。

## 6. 新需求缺口与联合验收

目前 `managedSchema: 1` 没有主干身份和持久披露日志。Annotation 已有 `dsh_upstream_read` / `dsh_upstream_search` 及预算；还需把实际返回片段、继续位置和结果状态归入图扩展域。记录不保存第二份正文，不以“后端搜索过”冒充“模型看过”。

实施需要联动：ThoughtDAG 图/菜单/来源预览 → Annotation 引用与工具 → Sticker 高亮/蓝色符号 → Maintenance 合同、图服务、读取回执、Adapter/schema/兼容清单和对应看板。不能只更新 ThoughtDAG 前端，然后让旧 Adapter 拒绝写入。

已有全局图数据不因取消功能被批量删除；旧图归属、原知识线和跨目标画布需要明确迁移。来源版本保留继续使用原策略，读取位置日志不得偷偷把所有版本永久钉住。

未来实现重点验证设计文档 AC23–AC40；本次仅完成文档差异、需求编号、内部链接和源码入口检查，不声称新功能已可运行。
